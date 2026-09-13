exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const GHL_KEY = process.env.GHL_API_KEY;
  const GHL_LOC = process.env.GHL_LOCATION_ID;
  if (!GHL_KEY || !GHL_LOC) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GHL credentials not configured' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  const { agentEmail, agentName, reviewUrl, month } = body;
  if (!agentEmail || !reviewUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing agentEmail or reviewUrl' }) };
  }

  const headers = {
    'Authorization': 'Bearer ' + GHL_KEY,
    'Content-Type': 'application/json',
    'Version': '2021-04-15'
  };

  try {
    let contactId = body.contactId || null;

    if (!contactId) {
      // Use correct GHL v2 search endpoint
      const searchRes = await fetch(
        'https://services.leadconnectorhq.com/contacts/search?locationId=' + GHL_LOC + '&query=' + encodeURIComponent(agentEmail),
        { headers }
      );
      const searchData = await searchRes.json();
      console.log('Search response:', JSON.stringify(searchData));

      if (searchData.contacts && searchData.contacts.length > 0) {
        contactId = searchData.contacts[0].id;
      } else {
        // Try alternate search endpoint
        const altRes = await fetch(
          'https://services.leadconnectorhq.com/contacts/?locationId=' + GHL_LOC + '&query=' + encodeURIComponent(agentEmail) + '&limit=1',
          { headers }
        );
        const altData = await altRes.json();
        console.log('Alt search response:', JSON.stringify(altData));

        if (altData.contacts && altData.contacts.length > 0) {
          contactId = altData.contacts[0].id;
        } else {
          // Create new contact
          const createRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              locationId: GHL_LOC,
              email: agentEmail,
              firstName: agentName ? agentName.split(' ')[0] : 'Agent',
              lastName: agentName ? agentName.split(' ').slice(1).join(' ') : ''
            })
          });
          const createData = await createRes.json();
          console.log('Create response:', JSON.stringify(createData));
          contactId = createData.contact ? createData.contact.id : (createData.id || null);
        }
      }
    }

    if (!contactId) {
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'Could not find or create contact. Check that ' + agentEmail + ' exists in GHL.' }) 
      };
    }

    // Send email
    const firstName = agentName ? agentName.split(' ')[0] : 'there';
    const emailHtml = `
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1A1A18;">
  <img src="https://yourmarketingdude.com/wp-content/uploads/2024/01/YMD-Logo.png" alt="Your Marketing Dude" style="height:50px;margin-bottom:24px;" onerror="this.style.display='none'"/>
  <h2 style="font-size:22px;font-weight:600;margin-bottom:8px;">Hey ${firstName} — your ${month || 'monthly'} content is ready!</h2>
  <p style="font-size:15px;color:#5A5A52;line-height:1.6;margin-bottom:24px;">
    Your social media posts and emails for ${month || 'this month'} are ready for your review. 
    Click below to see everything, check the photo suggestions, and let us know if it all sounds like you.
  </p>
  <a href="${reviewUrl}" style="display:inline-block;background:#1A1A18;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;margin-bottom:24px;">
    Review My Content →
  </a>
  <p style="font-size:13px;color:#9A9A90;line-height:1.6;">
    Takes about 5 minutes. The more feedback you give us, the better your content gets every month.
    <br/><br/>
    Talk soon,<br/>
    <strong>Your Marketing Dude Team</strong>
  </p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
  <p style="font-size:11px;color:#9A9A90;">
    If the button above doesn't work, copy and paste this link:<br/>
    <a href="${reviewUrl}" style="color:#1A4F8A;">${reviewUrl}</a>
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
        emailTo: agentEmail,
        subject: firstName + ' — Your ' + (month || 'Monthly') + ' Content Is Ready To Review',
        html: emailHtml,
        body: emailHtml
      })
    });

    const emailData = await emailRes.json();
    console.log('Email response:', JSON.stringify(emailData));

    if (!emailRes.ok) {
      return { 
        statusCode: emailRes.status, 
        body: JSON.stringify({ error: emailData.message || JSON.stringify(emailData) }) 
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, contactId })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
