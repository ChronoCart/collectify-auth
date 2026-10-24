// collectify-auth/api/whop.js — "Continue with Whop" for the Collectify app (OAuth 2.1 + PKCE, per
// docs.whop.com/developer/guides/oauth). Stateless: the PKCE verifier rides inside the signed `state`.
//
//   GET /api/whop?probe=1          → { configured: true|false }   (the app shows the button only when true)
//   GET /api/whop?redirect=app     → 302 to Whop's consent screen
//   GET /api/whop?code=…&state=…   → token exchange → userinfo → membership → collectify://auth?whop=<token>&linked=0|1…
//
// A Whop sign-in is NOT a session on its own. Whop's API exposes no Discord connection, and everything in
// Collectify (alerts, reports, setup) belongs to a Discord member — so the app then LINKS a Discord
// (Chris, 2026-10-23: "have them link discord… if they DO have a discord linked, show them it and ask them
// to confirm that's the right one"). The bot keeps whop_sub → discord_id (/clfy/whop-link); this function
// hands the app a short-lived signed Whop token plus the linked Discord if one is on file. The session is
// then issued by whop-session.js (confirm) or callback.js (link a new Discord) — always for a Discord id.
//
// Needs, on Vercel: WHOP_CLIENT_ID (OAuth app id "app_…", redirect URI = this function's URL), WHOP_API_KEY
// (company key, membership check), TOKEN_SECRET + BOT_URL + API_SECRET (already there). Optional:
// WHOP_CLIENT_SECRET, WHOP_COMPANY_ID (default: the Collectify business).
const COMPANY = process.env.WHOP_COMPANY_ID || 'biz_UqXx37D02IhD6n';
const SCOPE = 'openid profile email';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const selfUrl = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/whop`;
async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256b64u(s) { return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function signed(secret, obj) { const p = b64u(JSON.stringify(obj)); return p + '.' + (await hmac(secret, p)).slice(0, 32); }
async function verify(secret, tok, maxAgeMs) {
  const [p, sig] = String(tok || '').split('.'); if (!p || !sig || (await hmac(secret, p)).slice(0, 32) !== sig) return null;
  try { const o = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return Date.now() - (o.t || 0) > maxAgeMs ? null : o; } catch { return null; }
}
export default async function handler(req, res) {
  const q = req.query || {};
  const clientId = process.env.WHOP_CLIENT_ID, secret = process.env.TOKEN_SECRET || 'fallback_secret';
  if (q.probe) return res.status(200).json({ configured: !!(clientId && process.env.WHOP_API_KEY) });
  if (!clientId) return res.status(503).json({ ok: false, error: 'Whop sign-in is not configured' });
  const redirectUri = selfUrl(req);
  const fail = (why) => res.redirect(`collectify://auth?error=${encodeURIComponent(why)}`);
  // ── step 2: send to Whop ──
  if (!q.code) {
    const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const state = await signed(secret, { v: verifier, app: q.redirect === 'app' ? 1 : 0, t: Date.now() });
    const p = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state,
      nonce: b64u(crypto.getRandomValues(new Uint8Array(16))), code_challenge: await sha256b64u(verifier), code_challenge_method: 'S256' });
    return res.redirect(`https://api.whop.com/oauth/authorize?${p}`);
  }
  // ── step 3: back from Whop ──
  if (q.error) return fail(String(q.error_description || q.error));
  const st = await verify(secret, q.state, 15 * 60 * 1000);
  if (!st || !st.v) return fail('bad_state');
  const body = { grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: st.v };
  if (process.env.WHOP_CLIENT_SECRET) body.client_secret = process.env.WHOP_CLIENT_SECRET;
  const tok = await fetch('https://api.whop.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!tok.ok) return fail('token_failed');
  const { access_token } = await tok.json();
  const ui = await fetch('https://api.whop.com/oauth/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
  if (!ui.ok) return fail('userinfo_failed');
  const me = await ui.json();                       // { sub: "user_…", name?, preferred_username?, picture?, email? }
  if (!me.sub) return fail('no_user');
  // ── membership: does this Whop user hold a valid membership with the Collectify business? ──
  let paid = false;
  try {
    const r = await fetch(`https://api.whop.com/api/v1/memberships?user_id=${encodeURIComponent(me.sub)}&company_id=${encodeURIComponent(COMPANY)}&status=active`,
      { headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` } });
    if (r.ok) { const j = await r.json(); paid = Array.isArray(j.data) ? j.data.length > 0 : Array.isArray(j) ? j.length > 0 : false; }
  } catch (_) {}
  if (!st.app) return res.redirect(`${process.env.FRONTEND_URL}/collectify-dashboard.html?error=whop_app_only`);
  // ── hand the app a 30-minute Whop token + whatever Discord is already linked to this Whop user ──
  const username = String(me.preferred_username || me.name || me.sub).slice(0, 32);
  const whop = await signed(secret, { sub: me.sub, u: username, p: paid ? 1 : 0, t: Date.now() });
  let link = null;
  try {
    const botUrl = process.env.BOT_URL || process.env.CHECKOUT_BOT_URL, botSecret = process.env.API_SECRET || process.env.CHECKOUT_BOT_SECRET;
    const r = await fetch(`${botUrl}/clfy/whop-link?sub=${encodeURIComponent(me.sub)}&secret=${encodeURIComponent(botSecret)}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) link = (await r.json()).link || null;
  } catch (_) {}
  const params = new URLSearchParams({ whop, linked: link ? '1' : '0' });
  if (link) { params.set('lid', link.discord_id); if (link.username) params.set('lname', link.username); if (link.avatar) params.set('lavatar', link.avatar); }
  return res.redirect(`collectify://auth?${params}`);
}
