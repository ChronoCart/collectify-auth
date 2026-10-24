// collectify-auth/api/demo-login.js — the ONE dummy account App Store / Play reviewers sign in with.
// Reviewers cannot join the Collectify Discord, so the app's login screen has a "Reviewer sign-in"
// link that POSTs {user, pass} here. On a match we issue the SAME HMAC session callback.js issues
// (payload `${id}:${username}`, TOKEN_SECRET) for a Discord id that exists nowhere
// (100000000000000000). The bot treats that id as a demo (api-endpoints.js, /clfy/app): reports are
// swallowed, usage is never logged, prefs are pre-seeded. Rotate DEMO_PASS here AND in
// collectify-app/REVIEW-ACCOUNT.md AND in App Store Connect's review sign-in fields.
const DEMO_USER = 'reviewer';
const DEMO_PASS = 'vqyuEmeHs5qDIS';
const DEMO_ID = '100000000000000000';
const DEMO_NAME = 'App Reviewer';
const RATE = new Map(); // ip -> { n, t } : 5 attempts a minute, per instance

function same(a, b) { // constant-time compare on equal-length strings
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sign(id, username) {
  const secret = process.env.TOKEN_SECRET || 'fallback_secret';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(id + ':' + username));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '?').split(',')[0].trim();
  const now = Date.now(); const e = RATE.get(ip) || { n: 0, t: now };
  if (now - e.t > 60000) { e.n = 0; e.t = now; }
  e.n += 1; RATE.set(ip, e);
  if (e.n > 5) return res.status(429).json({ ok: false, error: 'too many attempts' });
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const user = String(body.user || '').trim().toLowerCase();
  const pass = String(body.pass || '');
  if (!same(user, DEMO_USER) || !same(pass, DEMO_PASS)) return res.status(401).json({ ok: false, error: 'invalid credentials' });
  const sig = await sign(DEMO_ID, DEMO_NAME);
  return res.status(200).json({ ok: true, id: DEMO_ID, username: DEMO_NAME, avatar: '', paid: '1', plan: 'Autocheckout', sig, demo: true });
}
