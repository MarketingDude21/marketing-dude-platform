// Uses a simple Google API key instead of service account JWT auth.
// This works for any folder/file set to "anyone with the link can view" —
// which is how all content calendar folders are set up. No sharing required
// ever again — just make sure each new folder is set to "anyone can view."
exports.handler = async (event) => {
  try {
    return await handleRequest(event);
  } catch(topErr) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Function crashed: ' + topErr.message })
    };
  }
};

async function handleRequest(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { folderId } = body;
  if (!folderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing folderId' }) };
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GOOGLE_API_KEY not set in Netlify env vars' }) };
  }

  try {
    // List all Google Docs in this folder using the API key
    const listUrl = 'https://www.googleapis.com/drive/v3/files?' +
      'q=' + encodeURIComponent(`'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`) +
      '&fields=files(id,name)' +
      '&pageSize=100' +
      '&key=' + apiKey;

    const listRes = await fetch(listUrl);
    const listData = await listRes.json();

    if (!listRes.ok) {
      throw new Error(listData.error?.message || 'Drive list failed: ' + listRes.status);
    }

    const files = listData.files || [];

    // Read all docs in parallel — export each as plain text
    const results = await Promise.all(files.map(async (f) => {
      try {
        const exportUrl = 'https://www.googleapis.com/drive/v3/files/' + f.id +
          '/export?mimeType=text%2Fplain&key=' + apiKey;
        const exportRes = await fetch(exportUrl);
        if (!exportRes.ok) return null;
        const text = await exportRes.text();
        return parseContentDoc(text, f.name);
      } catch(e) {
        console.log('Failed to parse doc', f.name, e.message);
        return null;
      }
    }));

    const docs = results.filter(Boolean);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docs,
        totalFiles: files.length,
        parsedCount: docs.length,
        fileNames: files.map(f => f.name) // debug: shows exactly what files the API found
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
}

// Parses a single doc's plain text against the templated format.
function parseContentDoc(text, fileName) {
  // Google Docs exports backslash-escaped brackets/periods in plain text
  // (e.g. \[ \] \.) — strip these before parsing.
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\\([[\]().*+?^${}|\\])/g, '$1')
    .trim();
  const title = fileName.replace(/\.(gdoc|docx?)$/i, '').trim();

  // PRIMARY RULE: use the document title/filename to determine type.
  // If title starts with "Email" → email
  // If title starts with "Video" → video
  // Everything else → post
  // This is simpler and more reliable than scanning doc content.
  const titleLower = title.toLowerCase().trim();

  if (/^email[\s:\-–—|]/i.test(title) || titleLower.startsWith('email')) {
    return parseEmailDoc(cleaned, title);
  }

  if (/^video[\s:\-–—|1-9]/i.test(title) || titleLower.startsWith('video')) {
    return parseVideoDoc(cleaned, title);
  }

  // Fallback: scan content for email/video signals in case title doesn't match
  const firstLine = cleaned.split('\n')[0].trim();
  const isEmailByContent = /(?:\d+\.\s*)?Email Goal/i.test(cleaned) ||
    /Subject Line Options/i.test(cleaned) ||
    /SUBJECT LINE OPTIONS/i.test(cleaned) ||
    /Email Instructions/i.test(cleaned) ||
    /Pick 1.*subject/i.test(cleaned) ||
    /EMAIL BODY/i.test(cleaned);
  const isVideoByContent = /(?:\d+\.\s*)?Video Goal/i.test(cleaned) ||
    /Video Script/i.test(cleaned) ||
    /Script Instructions/i.test(cleaned) ||
    /^video[\s:\-–—1-9]/i.test(firstLine);

  if (isEmailByContent) return parseEmailDoc(cleaned, title);
  if (isVideoByContent) return parseVideoDoc(cleaned, title);
  return parsePostDoc(cleaned, title);
}

function extractSection(text, startLabel, endLabels) {
  const startRe = new RegExp('(?:\\d+\\.\\s*)?' + startLabel, 'i');
  const startMatch = text.match(startRe);
  if (!startMatch) return '';

  // Skip the rest of the header line (bracket annotations, etc.)
  let startIdx = startMatch.index + startMatch[0].length;
  const newlineAfterHeader = text.indexOf('\n', startIdx);
  if (newlineAfterHeader !== -1) startIdx = newlineAfterHeader + 1;

  let endIdx = text.length;
  for (const label of endLabels) {
    const endRe = new RegExp('(?:\\d+\\.\\s*)?' + label, 'i');
    const endMatch = text.slice(startIdx).match(endRe);
    if (endMatch) {
      const candidateIdx = startIdx + endMatch.index;
      if (candidateIdx < endIdx) endIdx = candidateIdx;
    }
  }
  return text.slice(startIdx, endIdx).trim();
}

function parsePostDoc(text, title) {
  const goal = extractSection(text, 'Post Goal', ['Post Image', 'Image\\s*/\\s*Video Suggestions', 'Canva Template Direction', 'Post Copy']);
  const imageSection = extractSection(text, 'Post Image\\s*/\\s*Video Suggestions', ['Canva Template Direction', 'Post Copy']);
  const canvaSection = extractSection(text, 'Canva Template Direction', ['Post Copy']);

  // Post Copy — try numbered section first, then fall back to last section in doc
  let copy = extractSection(text, 'Post Copy', []);
  if (!copy) {
    // Try finding copy after the last numbered section header
    const lastSectionMatch = text.match(/(?:\d+\.\s*)(?:Post Copy|Copy)[^\n]*/i);
    if (lastSectionMatch) {
      copy = text.slice(lastSectionMatch.index + lastSectionMatch[0].length).trim();
    }
  }
  if (!copy) {
    // Last resort: take everything after "Template Link:" line or after image section
    const templateLinkIdx = text.search(/Template Link:/i);
    if (templateLinkIdx > -1) {
      const afterLink = text.indexOf('\n', templateLinkIdx);
      copy = text.slice(afterLink > -1 ? afterLink : templateLinkIdx).trim();
    }
  }

  if (!copy) return null;

  const imageLines = imageSection
    .split('\n')
    .map(function(l){ return l.replace(/^[-*•]\s*/, '').replace(/^Clip\s*\d+:\s*/i, '').replace(/^Option\s*\d+:\s*/i, '').trim(); })
    .filter(Boolean);
  const image = imageLines.join('; ');

  let canva = '';
  // Search entire doc for any Canva/template link — not just the Canva section
  // Handles formats: "Template Link: <url>", "[text](url)", bare https://canva.link/...
  const fullText = text;
  const canvaMatch =
    fullText.match(/Template Link:\s*<?(\S+?)>?(?:\s|$)/i) ||
    fullText.match(/\]\((https?:\/\/canva\.[^\s)]+)\)/i) ||
    fullText.match(/\(https?:\/\/canva\.link\/([^\s)]+)\)/i) ||
    fullText.match(/<(https?:\/\/canva\.[^\s>]+)>/i) ||
    fullText.match(/(https?:\/\/canva\.link\/\S+)/i) ||
    fullText.match(/(https?:\/\/www\.canva\.com\/\S+)/i);
  if (canvaMatch) canva = canvaMatch[1].trim().replace(/[<>()[\]]/g, '').replace(/\*\*/g, '').trim();

  return { type: 'post', title, goal, image, canva, copy };
}

function parseEmailDoc(text, title) {
  const goal = extractSection(text, 'Email Goal', ['Subject Line Options', 'Email Instructions', 'SUBJECT LINE']);

  // Subject lines — handle multiple formats:
  // "Subject Line Options", "SUBJECT LINE OPTIONS (Pick 1)", emoji + "SUBJECT LINE OPTIONS"
  const subjectSection = extractSection(text,
    'SUBJECT LINE OPTIONS?(?:\\s*\\([^)]*\\))?',
    ['Email Instructions', 'EMAIL BODY', 'Hey \\[', 'Hey,']
  ) || extractSection(text, 'Subject Line Options', ['Email Instructions', 'EMAIL BODY', 'Hey \\[', 'Hey,']);

  // Email body — handle "Email Instructions", "EMAIL BODY", or just the body starting with "Hey"
  let instructionsText = extractSection(text, 'Email Instructions', []) ||
    extractSection(text, 'EMAIL BODY[^:]*:', []) ||
    extractSection(text, 'Hey \\[', []) ||
    extractSection(text, 'Hey,', []);

  // Strip ALL instruction sections from email body — nuclear approach
  if (instructionsText) {
    instructionsText = instructionsText
      // Strip everything from any VISUAL ASSETS marker onward
      .replace(/---+[\s\n]*(?:VISUAL ASSETS|Image Idea)[\s\S]*/i, '')
      .replace(/#+\s*VISUAL ASSETS[\s\S]*/i, '')
      .replace(/\*\*VISUAL ASSETS[\s\S]*/i, '')
      .replace(/VISUAL ASSETS[\s\S]*/i, '')
      // Strip individual image idea blocks (markdown bold format from Google Docs)
      .replace(/\*\*Image Idea\s*\d*[:\s][^*]+\*\*[\s\S]*?(?=\*\*Image Idea|\Z)/gi, '')
      .replace(/\*\*Image Idea[\s\S]*/i, '')
      // Strip individual instruction lines
      .replace(/Business\/Event Name:.*/gi, '')
      .replace(/Official Website:.*/gi, '')
      .replace(/Source Page:.*/gi, '')
      .replace(/Suggested Image Source:.*/gi, '')
      .replace(/Backup Search Phrase:.*/gi, '')
      .replace(/\*\*Business:.*/gi, '')
      .replace(/\*\*Location:.*/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (!instructionsText && !goal) return null;

  const subjects = (subjectSection || '')
    .split('\n')
    .map(function(l){
      return l
        .replace(/^[-*•\d.)\s]+/, '')
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/\\/g, '')
        .trim();
    })
    .filter(function(l){ return l.length > 5 && !/^Pick\s+\d/i.test(l); });

  return { type: 'email', title, goal, subjects, instructions: instructionsText };
}

function parseVideoDoc(text, title) {
  const firstLine = text.split('\n')[0].trim();
  const isSimpleFormat = /^video[:\s]/i.test(firstLine);

  if (isSimpleFormat) {
    // Simple format: "Video: [concept or script content]"
    // The whole document after the first line is the script direction/concept.
    const lines = text.split('\n');
    const conceptTitle = firstLine.replace(/^video[:\s]*/i, '').trim() || title;
    const scriptContent = lines.slice(1).join('\n').trim() || firstLine;
    return {
      type: 'video',
      title: conceptTitle || title,
      goal: 'Short form video — ' + conceptTitle,
      hook: '',
      script: scriptContent || text
    };
  }

  // Template format with named sections
  const goal = extractSection(text, 'Video Goal', ['Hook', 'Script Instructions', 'Video Script']);
  const hook = extractSection(text, 'Hook', ['Script Instructions', 'Video Script', 'Body', 'Close']);
  const scriptInstructions = extractSection(text, 'Script Instructions', ['Video Script']);
  const script = extractSection(text, 'Video Script', []) || scriptInstructions;

  if (!script && !goal) return null;

  return { type: 'video', title, goal, hook, script };
}
// v1788932570
// cache-bust: 1788935936
