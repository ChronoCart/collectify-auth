// collectify-auth/api/whop.js — "Continue with Whop" for the Collectify app (OAuth 2.1 + PKCE, per
// docs.whop.com/developer/guides/oauth). Stateless: the PKCE verifier rides inside the signed `state`.
//
//   GET /api/whop?probe=1          → { configured: true|false }   (the app shows the button only when true)
//   GET /api/whop?redirect=app     → 302 to Whop's consent screen
//   GET /api/whop?code=…&state=…   → token exchange → userinfo → membership check → collectify://auth?…
//
// Needs, on Vercel: WHOP_CLIENT_ID (the OAuth app id, "app_…"; its redirect URI must be exactly this
// function's URL), WHOP_API_KEY (a company API key, to confirm the user holds a valid membership) and
// TOKEN_SECRET (already there — same HMAC session callback.js issues). Optional: WHOP_CLIENT_SECRET,
// WHOP_COMPANY_ID (default: the Collectify business).
//
// ⚠️ Whop's API exposes NO Discord connection for a user, so a Whop login cannot be tied to the member's
// Discord id. The session id is a stable 18-digit number derived from the Whop user id instead — the bot
// treats it like any member id (prefs, push, reports, usage), but it is a SEPARATE identity from the
// same person's Discord login.
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
// Whop user id → stable 18-digit "snowflake-shaped" id the bot accepts (/^\d{17,19}$/): a leading 2 so it
// can never collide with a real Discord id minted this decade, then 17 digits of the hash.
async function syntheticId(sub) {
  const h = await hmac(process.env.TOKEN_SECRET || 'fallback_secret', 'whop:' + sub);
  return '2' + BigInt('0x' + h.slice(0, 24)).toString().padStart(17, '0').slice(0, 17);
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
    const payload = b64u(JSON.stringify({ v: verifier, app: q.redirect === 'app' ? 1 : 0, t: Date.now() }));
    const state = payload + '.' + (await hmac(secret, payload)).slice(0, 32);
    const p = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state,
      nonce: b64u(crypto.getRandomValues(new Uint8Array(16))), code_challenge: await sha256b64u(verifier), code_challenge_method: 'S256' });
    return res.redirect(`https://api.whop.com/oauth/authorize?${p}`);
  }
  // ── step 3: back from Whop ──
  if (q.error) return fail(String(q.error_description || q.error));
  const [payload, sig] = String(q.state || '').split('.');
  if (!payload || !sig || (await hmac(secret, payload)).slice(0, 32) !== sig) return fail('bad_state');
  let st; try { st = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return fail('bad_state'); }
  if (!st.v || Date.now() - (st.t || 0) > 15 * 60 * 1000) return fail('state_expired');
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
  const id = await syntheticId(me.sub);
  const username = String(me.preferred_username || me.name || me.sub).slice(0, 32);
  const params = new URLSearchParams({ id, username, avatar: me.picture || '', paid: paid ? '1' : '0', plan: paid ? 'Whop' : '', sig: await hmac(secret, `${id}:${username}`), provider: 'whop' });
  if (st.app) return res.redirect(`collectify://auth?${params}`);
  return res.redirect(`${process.env.FRONTEND_URL}/collectify-dashboard.html?${params}`);
}
