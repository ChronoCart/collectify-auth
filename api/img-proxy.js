// api/img-proxy.js
// Proxies product images for canvas cross-origin access
// Accepts any public HTTPS image URL — blocks private/local IPs (SSRF protection)

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) { res.status(400).json({ error: 'Missing url param' }); return; }

  // Must be HTTPS
  if (!url.startsWith('https://')) {
    res.status(403).json({ error: 'Only HTTPS URLs allowed' }); return;
  }

  // Block private/local IP ranges (SSRF protection)
  let hostname;
  try { hostname = new URL(url).hostname; } catch {
    res.status(400).json({ error: 'Invalid URL' }); return;
  }
  const blocked = ['localhost','127.','10.','192.168.','172.16.','169.254.','::1'];
  if (blocked.some(b => hostname.startsWith(b) || hostname === b)) {
    res.status(403).json({ error: 'Private addresses not allowed' }); return;
  }

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
