// collectify-auth / api/change-requests.js
//
// Proxies the dashboard's change-request calls to the Collectify "Change Requests" Apps
// Script. Same shape as the ChronoCart one: the member's identity is verified here (HMAC),
// then the script SECRET + the verified discordId are added server-side — the browser never
// sees the secret and can't spoof another member's id.
//
// ENV on Vercel (collectify-auth):
//   CF_CHANGE_REQ_SCRIPT_URL     = the Apps Script /exec URL
//   CF_CHANGE_REQ_SCRIPT_SECRET  = the SECRET constant in collectify-change-requests.gs
//   TOKEN_SECRET                 = (already set — same HMAC key /api/data uses)

const RATE_LIMIT = new Map();
function checkRateLimit(ip) {
  const now = Date.now(), windowMs = 60 * 1000, max = 30;
  const e = RATE_LIMIT.get(ip) || { count: 0, start: now };
  if (now - e.start > windowMs) { RATE_LIMIT.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; RATE_LIMIT.set(ip, e); return true;
}

async function verify(id, username, sig) {
  const secret = process.env.TOKEN_SECRET;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = new Uint8Array(sig.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return crypto.subtle.verify('HMAC', key, bytes, enc.encode(`${id}:${username || ''}`));
}

export default async function handler(req, res) {
  // '*' not a fixed origin: the Collectify dashboard may be served from Netlify, a file://
  // preview, or chronocart.xyz, and a pinned Origin silently 403s the ones it doesn't know.
  // The security boundary here is the HMAC sig, not the Origin header.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: 'Too many requests' });

  const { id, sig, username } = req.query;
  if (!id || !sig) return res.status(400).json({ ok: false, error: 'Missing params' });
  try {
    if (!(await verify(id, username, sig))) return res.status(401).json({ ok: false, error: 'Invalid signature' });
  } catch { return res.status(401).json({ ok: false, error: 'Verification failed' }); }

  const base = process.env.CF_CHANGE_REQ_SCRIPT_URL;
  const secret = process.env.CF_CHANGE_REQ_SCRIPT_SECRET;
  if (!base || !secret) return res.status(503).json({ ok: false, error: 'change-request script not configured' });

  try {
    if (req.method === 'GET') {
      const url = `${base}?secret=${encodeURIComponent(secret)}&discordId=${encodeURIComponent(id)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      // The member sends { retailer, profileName, reason, changes }. We inject the secret and
      // the VERIFIED discordId — never trusting a discordId from the body.
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const payload = { ...body, secret, discordId: id };
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'change-request script unreachable' });
  }
}
