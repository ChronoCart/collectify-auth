// collectify-auth/api/whop-session.js — the app confirmed "yes, that's my Discord" after a Whop sign-in.
// POST { whop } (the token whop.js issued) → the link on file is re-read from the bot → the SAME HMAC
// session callback.js issues, for that Discord id. No link on file → 409 and the app walks them through
// linking one (api/auth.js?redirect=app&link=<whop>). Never issues a session for a Whop-only identity.
async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verify(secret, tok, maxAgeMs) {
  const [p, sig] = String(tok || '').split('.'); if (!p || !sig || (await hmac(secret, p)).slice(0, 32) !== sig) return null;
  try { const o = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return Date.now() - (o.t || 0) > maxAgeMs ? null : o; } catch { return null; }
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  let body = req.body || {}; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const secret = process.env.TOKEN_SECRET || 'fallback_secret';
  const w = await verify(secret, body.whop, 30 * 60 * 1000);
  if (!w || !w.sub) return res.status(401).json({ ok: false, error: 'whop token invalid or expired — sign in with Whop again' });
  const botUrl = process.env.BOT_URL || process.env.CHECKOUT_BOT_URL, botSecret = process.env.API_SECRET || process.env.CHECKOUT_BOT_SECRET;
  if (!botUrl || !botSecret) return res.status(500).json({ ok: false, error: 'bot not configured' });
  let link = null;
  try { const r = await fetch(`${botUrl}/clfy/whop-link?sub=${encodeURIComponent(w.sub)}&secret=${encodeURIComponent(botSecret)}`, { signal: AbortSignal.timeout(8000) }); if (r.ok) link = (await r.json()).link || null; }
  catch (e) { return res.status(502).json({ ok: false, error: 'bot unreachable' }); }
  if (!link || !/^\d{17,19}$/.test(String(link.discord_id))) return res.status(409).json({ ok: false, error: 'not_linked' });
  try { await fetch(`${botUrl}/clfy/whop-link?secret=${encodeURIComponent(botSecret)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: w.sub, discord_id: link.discord_id, confirm: 1 }), signal: AbortSignal.timeout(8000) }); } catch (_) {}
  const id = String(link.discord_id), username = String(link.username || w.u || '').slice(0, 32);
  const sig = await hmac(secret, `${id}:${username}`);
  return res.status(200).json({ ok: true, id, username, avatar: link.avatar || '', paid: w.p ? '1' : '0', plan: w.p ? 'Whop' : '', sig, provider: 'whop' });
}
