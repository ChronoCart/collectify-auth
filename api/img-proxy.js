// api/img-proxy.js
// Proxies product images that block cross-origin canvas access (PKC, etc.)
// Usage: /api/img-proxy?url=https://images.pokemoncenter.com/...

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) { res.status(400).json({ error: 'Missing url param' }); return; }

  // Only proxy known image CDNs — don't become an open proxy
  const allowed = [
    'images.pokemoncenter.com',
    'assets.pokemon.com',
    'target.scene7.com',
    'assets.target.com',
    'i5.walmartimages.com',
    'scene7.com',
  ];
  const isAllowed = allowed.some(domain => url.includes(domain));
  if (!isAllowed) { res.status(403).json({ error: 'Domain not allowed' }); return; }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChronoCartBot/1.0)' }
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = await upstream.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
