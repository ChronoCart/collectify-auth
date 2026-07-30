// collectify-auth / api/tracker.js
//
// ONE proxy for the whole Order Tracking feature. The bot already exposes /orders,
// /orders/refresh, /orders/progress and /imap-accounts (api-endpoints.js) keyed by
// ?id=<discordId> — none of it is ChronoCart-specific, so Collectify reuses it as-is.
// This file is the Collectify-side gate: it verifies the member's HMAC session, then adds
// the bot secret server-side. The browser never sees CHECKOUT_BOT_SECRET.
//
// Everything is funnelled through ONE serverless file with ?route= rather than four
// separate files, so there is exactly one place where the allowlist lives.
//
// ENV on Vercel (collectify-auth) — all already set for /api/data:
//   TOKEN_SECRET, CHECKOUT_BOT_URL, CHECKOUT_BOT_SECRET

// route → { path on the bot, methods we allow, query params we forward }
const ROUTES = {
  'faq-quiz-questions': { path: '/faq-quiz-clfy/questions', methods: ['GET'],  params: [] },
  'faq-quiz-status':    { path: '/faq-quiz-clfy/status',    methods: ['GET'],  params: [] },
  'faq-quiz-submit':    { path: '/faq-quiz-clfy/submit',    methods: ['POST'], params: [] },
  'orders':          { path: '/orders',           methods: ['GET'],            params: [] },
  'orders-progress': { path: '/orders/progress',  methods: ['GET'],            params: [] },
  'orders-refresh':  { path: '/orders/refresh',   methods: ['POST'],           params: ['rescan', 'days'] },
  'imap-accounts':   { path: '/imap-accounts',    methods: ['GET', 'POST', 'DELETE'], params: ['accountId'] },
  // Custom Target Requests — GET the member's items; POST {tcin, op:add|remove} in the body.
  'collectify-custom': { path: '/collectify-custom', methods: ['GET', 'POST'], params: [] },
  // Requestable Target items catalog (shared tcins board) for the Custom Targets tab.
  'tcins':           { path: '/tcins',           methods: ['GET'],            params: [] },
};

const RATE_LIMIT = new Map();
function checkRateLimit(ip) {
  const now = Date.now(), windowMs = 60 * 1000, max = 120; // progress polling is ~1/sec
  const e = RATE_LIMIT.get(ip) || { count: 0, start: now };
  if (now - e.start > windowMs) { RATE_LIMIT.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; RATE_LIMIT.set(ip, e); return true;
}

async function verify(id, username, sig) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(process.env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const bytes = new Uint8Array(sig.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return crypto.subtle.verify('HMAC', key, bytes, enc.encode(`${id}:${username || ''}`));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const { id, sig, username, route } = req.query;
  if (!id || !sig) return res.status(400).json({ error: 'Missing params' });

  const r = ROUTES[route];
  if (!r) return res.status(404).json({ error: 'Unknown route' });
  if (!r.methods.includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!(await verify(id, username, sig))) return res.status(401).json({ error: 'Invalid signature' });
  } catch { return res.status(401).json({ error: 'Verification failed' }); }

  const botUrl = process.env.CHECKOUT_BOT_URL;
  const botSecret = process.env.CHECKOUT_BOT_SECRET;
  if (!botUrl || !botSecret) return res.status(503).json({ error: 'bot not configured' });

  // The id is taken from the VERIFIED session, never from the body — a member cannot read
  // or refresh another member's mailbox by editing the request.
  const qs = new URLSearchParams({ id, secret: botSecret });
  for (const p of r.params) if (req.query[p] != null) qs.set(p, String(req.query[p]));

  const init = { method: req.method, signal: AbortSignal.timeout(15000) };
  if (req.method === 'POST' && (route === 'imap-accounts' || route === 'collectify-custom' || route === 'faq-quiz-submit')) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(typeof req.body === 'object' && req.body ? req.body : {});
  }

  try {
    const botRes = await fetch(`${botUrl}${r.path}?${qs}`, init);
    const text = await botRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: 'Bad response from bot' }; }
    return res.status(botRes.status).json(data);
  } catch (err) {
    // A refresh is fire-and-forget on the bot side; a timeout here does NOT mean the scan
    // died. Say so, and let the dashboard fall through to polling /orders-progress.
    if (req.method === 'POST' && route === 'orders-refresh') {
      return res.status(202).json({ ok: true, started: true, note: 'proxy timed out; scan may still be running' });
    }
    return res.status(502).json({ error: 'Bot unreachable' });
  }
}
