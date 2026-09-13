exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) };
  }

  const { query, city } = body;
  if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'Missing query' }) };

  const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
  if (!UNSPLASH_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Unsplash key not configured' }) };
  }

  const buildUrl = (q, count) =>
    'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(q) +
    '&per_page=' + count + '&orientation=landscape&content_filter=high';

  const mapPhotos = (results) => results.map(function(p) {
    return {
      id: p.id,
      url: p.urls.raw + '&w=800&q=70&fm=jpg&fit=max',
      thumb: p.urls.raw + '&w=300&q=60&fm=jpg&fit=max',
      description: p.description || p.alt_description || query,
      credit: p.user.name,
      creditUrl: p.user.links.html + '?utm_source=yourmarketingdude&utm_medium=referral',
      downloadUrl: p.links.download_location
    };
  });

  try {
    let photos = [];

    // Primary: use the AI-generated query as-is — it already references
    // specific places, events, seasons from the email content
    const primaryRes = await fetch(buildUrl(query, 6), {
      headers: { 'Authorization': 'Client-ID ' + UNSPLASH_KEY }
    });
    const primaryData = await primaryRes.json();
    if (primaryRes.ok && primaryData.results && primaryData.results.length) {
      photos = mapPhotos(primaryData.results);
    }

    // If still under 3, try a broader version of the query
    if (photos.length < 3) {
      const broadQuery = query.split(' ').slice(0, 2).join(' ');
      const broadRes = await fetch(buildUrl(broadQuery, 6), {
        headers: { 'Authorization': 'Client-ID ' + UNSPLASH_KEY }
      });
      const broadData = await broadRes.json();
      if (broadRes.ok && broadData.results) {
        const existingIds = new Set(photos.map(function(p){ return p.id; }));
        mapPhotos(broadData.results).forEach(function(p) {
          if (!existingIds.has(p.id) && photos.length < 6) {
            photos.push(p);
            existingIds.add(p.id);
          }
        });
      }
    }

    photos = photos.slice(0, 6);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photos })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
