// Fetches photos from a Google Drive folder, downloads them server-side,
// and sends them to Claude for analysis. Returns a description and suggested
// post caption for each photo, using the agent's Voice DNA for tone.
// This runs server-side because browsers can't fetch Drive images directly (CORS).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { folderId, voiceDna, agentName, agentCity, maxPhotos, excludeFileIds } = body;
  if (!folderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing folderId' }) };
  }

  const excluded = new Set(excludeFileIds || []);

  const apiKey = process.env.GOOGLE_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }) };
  if (!anthropicKey) return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  try {
    // First find the "used" subfolder so we can exclude those photos
    const usedFolderUrl = 'https://www.googleapis.com/drive/v3/files?' +
      'q=' + encodeURIComponent(`name='used' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`) +
      '&fields=files(id,name)&key=' + apiKey;
    const usedFolderRes = await fetch(usedFolderUrl);
    const usedFolderData = await usedFolderRes.json();
    let usedFileIds = new Set(excludeFileIds || []);

    // If used folder exists, get all file IDs inside it to exclude
    if (usedFolderData.files && usedFolderData.files.length) {
      const usedFolderId = usedFolderData.files[0].id;
      const usedFilesUrl = 'https://www.googleapis.com/drive/v3/files?' +
        'q=' + encodeURIComponent(`'${usedFolderId}' in parents and trashed=false`) +
        '&fields=files(id)&pageSize=200&key=' + apiKey;
      const usedFilesRes = await fetch(usedFilesUrl);
      const usedFilesData = await usedFilesRes.json();
      if (usedFilesData.files) {
        usedFilesData.files.forEach(function(f){ usedFileIds.add(f.id); });
      }
    }

    // List image files in the folder — direct children only (not used subfolder children)
    const listUrl = 'https://www.googleapis.com/drive/v3/files?' +
      'q=' + encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed=false`) +
      '&fields=files(id,name,mimeType)' +
      '&pageSize=100' +
      '&key=' + apiKey;

    const listRes = await fetch(listUrl);
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(listData.error?.message || 'Drive list failed');

    const files = listData.files || [];
    if (!files.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: [], totalPhotos: 0 })
      };
    }

    // Filter out used photos and already-scanned photos, then limit to requested count
    const toProcess = files.filter(f => !usedFileIds.has(f.id)).slice(0, Math.min(files.length, maxPhotos || 5));

    const results = await Promise.all(toProcess.map(async (f) => {
      try {
        // Download the image from Drive
        const imgUrl = 'https://www.googleapis.com/drive/v3/files/' + f.id +
          '?alt=media&key=' + apiKey;
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) return null;

        // Convert to base64
        const arrayBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');

        // Determine media type — normalize HEIC to jpeg for Claude
        // (Claude accepts jpeg, png, gif, webp)
        let mediaType = f.mimeType || 'image/jpeg';
        if (mediaType === 'image/heif' || mediaType === 'image/heic' || f.name.match(/\.heic$/i)) {
          // HEIC can't be sent directly to Claude — skip and note it
          return {
            fileId: f.id,
            fileName: f.name,
            skipped: true,
            reason: 'HEIC format not supported for AI analysis — convert to JPG first'
          };
        }
        if (!['image/jpeg','image/png','image/gif','image/webp'].includes(mediaType)) {
          mediaType = 'image/jpeg'; // fallback
        }

        // Send to Claude for analysis and caption generation
        const prompt = 'You are creating a social media post for a real estate agent named ' + (agentName || 'the agent') + ' in ' + (agentCity || 'their city') + '.\n\n' +
          'VOICE DNA:\n' + (voiceDna || 'Warm, authentic, conversational. Sounds like a real person, not a real estate agent.') + '\n\n' +
          'Look at this photo and write a social media post that:\n' +
          '1. Starts from what you actually see — the setting, the mood, the moment\n' +
          '2. Sounds EXACTLY like this person based on their Voice DNA above\n' +
          '3. Is 1-3 sentences max — short, human, texted-a-friend energy\n' +
          '4. Does NOT mention real estate directly unless it is obviously a real estate moment\n' +
          '5. Does NOT mention any specific location, city, neighborhood, or place name — we don\'t always know where the photo was taken\n' +
          '6. NO hyphens, NO corporate language, NO AI-tell phrases\n' +
          '7. Standard capitalization — capitalize the first word of every sentence, never write in all lowercase\n\n' +
          'Also describe what you see in the photo in one short sentence (for the VA to tag/catalog).\n\n' +
          'Output format:\n' +
          'DESCRIPTION: [one sentence of what you see]\n' +
          'POST: [the social media caption]';

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64
                  }
                },
                { type: 'text', text: prompt }
              ]
            }]
          })
        });

        const claudeData = await claudeRes.json();
        if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error');

        const raw = claudeData.content.map(function(b){ return b.text || ''; }).join('').trim();
        const descMatch = raw.match(/DESCRIPTION:\s*(.+)/i);
        const postMatch = raw.match(/POST:\s*([\s\S]+)/i);

        return {
          fileId: f.id,
          fileName: f.name,
          driveUrl: 'https://drive.google.com/file/d/' + f.id + '/view',
          thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + f.id + '&sz=w400',
          description: descMatch ? descMatch[1].trim() : 'Photo from Drive',
          suggestedPost: postMatch ? postMatch[1].trim() : raw
        };

      } catch(e) {
        console.log('Failed to analyze photo', f.name, e.message);
        return null;
      }
    }));

    const posts = results.filter(Boolean);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        posts,
        totalPhotos: files.length,
        analyzed: toProcess.length,
        skipped: posts.filter(function(p){ return p.skipped; }).length
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
