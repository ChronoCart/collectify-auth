// api/test-imap.js
const BOT_URL    = process.env.BOT_URL;
const API_SECRET = process.env.API_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).end('Method not allowed'); return; }

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
      }
    );

    const text = await botResp.text();
    console.log('[test-imap] bot status:', botResp.status, 'body:', text);

    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    // If bot returned an array, good. If not, wrap so dashboard gets a clear error.
    if (!Array.isArray(data)) {
      return res.status(200).json([{ ok: false, label: 'Error', user: '', error: typeof data === 'object' ? JSON.stringify(data) : data }]);
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(200).json([{ ok: false, label: 'Error', user: '', error: 'Bot unreachable: ' + err.message }]);
  }
}
