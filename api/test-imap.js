// api/test-imap.js — Vercel proxy for the forms' "Test IMAP" button.
// Paste into BOTH chronocart-auth/api/test-imap.js AND collectify-auth/api/test-imap.js,
// commit, and let Vercel auto-deploy. (These repos are GitHub-only — edit in the web editor.)
//
// Changes vs the old version:
//   • A secret/authorization failure (bot 401/403) now shows a CLEAR "authorization error, tell
//     staff" message instead of dumping the bot's raw 'Unauthorized' — so it can never be mistaken
//     for a bad app password. This is the message members were reading as a "bad secret" error.
//   • A real 33s timeout on the call to the bot, so a slow-but-valid mailbox fails cleanly with a
//     "took too long, try again" message instead of hanging until Vercel kills the function.
//   • maxDuration raised so the function isn't cut off at the 10s default mid-check.
//   • Guards for a missing BOT_URL / API_SECRET env (the actual root cause of the auth errors —
//     make sure BOTH repos' API_SECRET matches the bot's current .env API_SECRET).

const BOT_URL = process.env.BOT_URL;
const API_SECRET = process.env.API_SECRET;

export const config = { maxDuration: 35 };   // needs a plan allowing >10s functions

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).end('Method not allowed'); return; }

  if (!BOT_URL || !API_SECRET) {
    return res.status(200).json([{ ok: false, label: 'Error', user: '',
      error: 'The IMAP checker is misconfigured on our end (missing bot URL or secret). Please tell staff.' }]);
  }

  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    const botResp = await fetch(
      `${BOT_URL}/test-imap?secret=${encodeURIComponent(API_SECRET)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
        signal: AbortSignal.timeout(33000),   // fail cleanly before Vercel kills the function
      }
    );

    const text = await botResp.text();
    console.log('[test-imap] bot status:', botResp.status, 'body:', String(text).slice(0, 300));

    // Auth failure is OUR problem (stale/mismatched secret), NOT the member's password.
    if (botResp.status === 401 || botResp.status === 403) {
      return res.status(200).json([{ ok: false, label: 'Error', user: '',
        error: 'The IMAP checker rejected our request (authorization error). Your app password is probably fine — please tell staff so we can reconnect the checker.' }]);
    }

    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!Array.isArray(data)) {
      return res.status(200).json([{ ok: false, label: 'Error', user: '',
        error: (data && typeof data === 'object') ? JSON.stringify(data) : (String(text || '').trim() || 'Unexpected response from the checker.') }]);
    }

    return res.status(200).json(data);
  } catch (err) {
    const m = String(err && err.message || '');
    const friendly = /abort|timeout|timed out/i.test(m)
      ? 'The checker took too long to respond — this is usually a slow mail provider. Wait a moment and test again.'
      : 'Bot unreachable: ' + m;
    return res.status(200).json([{ ok: false, label: 'Error', user: '', error: friendly }]);
  }
}
