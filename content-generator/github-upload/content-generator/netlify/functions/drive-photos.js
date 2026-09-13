// Reads photos from a Drive folder, excluding the "used" subfolder.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { folderId } = body;
  if (!folderId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing folderId' }) };

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'GOOGLE_API_KEY not set' }) };

  try {
    // First find the "used" subfolder ID so we can exclude its contents
    const subfolderUrl = 'https://www.googleapis.com/drive/v3/files?' +
      'q=' + encodeURIComponent(`name='used' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`) +
      '&fields=files(id,name)&key=' + apiKey;

    const subfolderRes = await fetch(subfolderUrl);
    const subfolderData = await subfolderRes.json();
    const usedFolderId = subfolderData.files && subfolderData.files.length ? subfolderData.files[0].id : null;

    // Build query — only files directly in the photo folder, not the "used" subfolder
    // Explicitly exclude files that are children of the "used" folder
    let q = `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed=false`;

    const url = 'https://www.googleapis.com/drive/v3/files?' +
      'q=' + encodeURIComponent(q) +
      '&fields=files(id,name,mimeType,parents)' +
      '&pageSize=200' +
      '&key=' + apiKey;

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Drive API error: ' + res.status);

    // Filter out any files whose parent is the "used" folder (belt and suspenders)
    const files = (data.files || [])
      .filter(function(f) {
        if (!usedFolderId) return true;
        // Exclude if file's parents include the used folder
        return !(f.parents && f.parents.includes(usedFolderId));
      })
      .map(function(f) {
        return {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          isVideo: f.mimeType && f.mimeType.startsWith('video/'),
          thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + f.id + '&sz=w400',
          viewUrl: 'https://drive.google.com/file/d/' + f.id + '/view'
        };
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, usedFolderId })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
