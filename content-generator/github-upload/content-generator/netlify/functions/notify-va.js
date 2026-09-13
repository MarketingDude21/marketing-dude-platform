exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const GHL_KEY = process.env.GHL_API_KEY;
  const GHL_LOC = process.env.GHL_LOCATION_ID;
  // The inbox that should receive "client finished reviewing" notifications.
  // Set VA_NOTIFY_EMAIL in Netlify env vars to whoever should see these.
  const NOTIFY_EMAIL = process.env.VA_NOTIFY_EMAIL;

  if (!GHL_KEY || !GHL_LOC) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GHL credentials not configured' }) };
  }
  if (!NOTIFY_EMAIL) {
    // Don't hard-fail the client's flow just because notifications aren't configured yet —
    // this endpoint is called fire-and-forget from review.html.
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'VA_NOTIFY_EMAIL not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { agentName, agentId, batchId, month, approvedCount, flaggedCount, total } = body;

  const headers = {
    'Authorization': 'Bearer ' + GHL_KEY,
    'Content-Type': 'application/json',
    'Version': '2021-04-15'
  };

  try {
    let contactId = null;

    // Find or create the notify recipient as a GHL contact, same pattern as send-review.js
    const searchRes = await fetch(
      'https://services.leadconnectorhq.com/contacts/search?locationId=' + GHL_LOC + '&query=' + encodeURIComponent(NOTIFY_EMAIL),
      { headers }
    );
    const searchData = await searchRes.json();
    if (searchData.contacts && searchData.contacts.length > 0) {
      contactId = searchData.contacts[0].id;
    } else {
      const altRes = await fetch(
        'https://services.leadconnectorhq.com/contacts/?locationId=' + GHL_LOC + '&query=' + encodeURIComponent(NOTIFY_EMAIL) + '&limit=1',
        { headers }
      );
      const altData = await altRes.json();
      if (altData.contacts && altData.contacts.length > 0) {
        contactId = altData.contacts[0].id;
      } else {
        const createRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            locationId: GHL_LOC,
            email: NOTIFY_EMAIL,
            firstName: 'Sweet Assist',
            lastName: 'Notifications'
          })
        });
        const createData = await createRes.json();
        contactId = createData.contact ? createData.contact.id : (createData.id || null);
      }
    }

    if (!contactId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not find or create notify contact for ' + NOTIFY_EMAIL }) };
    }

    const reviewedAllClean = flaggedCount === 0;
    const subject = (reviewedAllClean ? '✓ ' : '⚑ ') + agentName + ' finished reviewing ' + (month || 'their content') +
      (reviewedAllClean ? ' — all approved' : ' — ' + flaggedCount + ' need' + (flaggedCount===1?'s':'') + ' a look');

    const emailHtml = `
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1A1A18;">
  <h2 style="font-size:20px;font-weight:600;margin-bottom:8px;">${agentName} finished reviewing ${month || 'their content'}</h2>
  <p style="font-size:15px;color:#5A5A52;line-height:1.6;margin-bottom:16px;">
    ${approvedCount} of ${total} approved as-is. ${flaggedCount > 0 ? flaggedCount + ' rewritten based on their feedback — worth a quick look before exporting.' : 'No edits needed — ready to export and schedule.'}
  </p>
  <p style="font-size:13px;color:#9A9A90;line-height:1.6;">
    Open Sweet Assist, go to the agent's Open Orders, and pull up this batch to finalize and export.
  </p>
</body>
</html>`.trim();

    const emailRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'Email',
        contactId: contactId,
        locationId: GHL_LOC,
        emailFrom: 'info@info.yourmarketingdude.com',
        emailTo: NOTIFY_EMAIL,
        subject: subject,
        html: emailHtml,
        body: emailHtml
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      return { statusCode: emailRes.status, body: JSON.stringify({ error: emailData.message || JSON.stringify(emailData) }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
  } catch(err) {
    // Notification failures should never surface as errors to the client review page —
    // log and swallow.
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
