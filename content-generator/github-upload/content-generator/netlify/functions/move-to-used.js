// Moves selected photos to a "used" subfolder inside the agent's photo folder.
// Uses OAuth2 refresh token — works with personal Google accounts, no folder
// sharing or admin console required. Token refreshes automatically.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { fileIds, photoFolderId } = body;
  if (!fileIds || !fileIds.length || !photoFolderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing fileIds or photoFolderId' }) };
  }

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing GOOGLE_REFRESH_TOKEN, GOOGLE_OAUTH_CLIENT_ID, or GOOGLE_OAUTH_CLIENT_SECRET env vars' }) };
  }

  try {
    // Exchange refresh token for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not get access token: ' + JSON.stringify(tokenData) }) };
    }
    const accessToken = tokenData.access_token;

    // Find or create the "used" subfolder
    const searchRes = await fetch(
      'https://www.googleapis.com/drive/v3/files?q=' +
      encodeURIComponent(`name='used' and '${photoFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`) +
      '&fields=files(id,name)',
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    const searchData = await searchRes.json();

    let usedFolderId;
    if (searchData.files && searchData.files.length) {
      usedFolderId = searchData.files[0].id;
    } else {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'used', mimeType: 'application/vnd.google-apps.folder', parents: [photoFolderId] })
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        return { statusCode: 200, body: JSON.stringify({ moved: 0, error: 'Cannot create used folder: ' + (createData.error?.message || 'unknown') }) };
      }
      usedFolderId = createData.id;
    }

    // Move each file into the used folder
    const results = await Promise.all(fileIds.map(async (fileId) => {
      try {
        // Get current parents
        const metaRes = await fetch(
          'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=parents,name',
          { headers: { 'Authorization': 'Bearer ' + accessToken } }
        );
        const metaData = await metaRes.json();
        if (!metaRes.ok) return { fileId, success: false, error: metaData.error?.message || 'Cannot read file' };

        const currentParents = (metaData.parents || []).join(',');

        const moveRes = await fetch(
          'https://www.googleapis.com/drive/v3/files/' + fileId +
          '?addParents=' + usedFolderId +
          (currentParents ? '&removeParents=' + currentParents : '') +
          '&fields=id,name,parents',
          { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + accessToken } }
        );

        if (!moveRes.ok) {
          const moveErr = await moveRes.json();
          return { fileId, success: false, error: moveErr.error?.message || 'Move failed', name: metaData.name };
        }
        return { fileId, success: true, name: metaData.name };
      } catch(e) {
        return { fileId, success: false, error: e.message };
      }
    }));

    const moved = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moved,
        total: fileIds.length,
        usedFolderId,
        results,
        error: failed.length ? failed.map(f => (f.name || f.fileId) + ': ' + f.error).join('; ') : null
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
