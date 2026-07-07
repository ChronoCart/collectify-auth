// api/discord-card.js
// Uses native Node 18+ FormData + fetch — no npm packages needed
// Env var: DISCORD_WEBHOOK_MEMBER_SUCCESS

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const webhookUrl = process.env.DISCORD_WEBHOOK_MEMBER_SUCCESS;
  if (!webhookUrl) { res.status(500).json({ error: 'Webhook not configured' }); return; }

  try {
    const { imageBase64, username, userId, period, orders, quantity } = req.body;
    if (!imageBase64) { res.status(400).json({ error: 'Missing image' }); return; }

    const base64Data = imageBase64.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const periodLabels = { day: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' };
    const periodLabel = periodLabels[period] || period;

    const payload = {
      content: `🔥 <@${userId}> *(${periodLabel})*`,
      embeds: [{
        color: 0xe8450a,
        image: { url: 'attachment://checkout-card.png' },
      }]
    };

    // Native FormData (Node 18+)
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'checkout-card.png');

    const discordRes = await fetch(webhookUrl, { method: 'POST', body: form });

    if (!discordRes.ok) {
      const errText = await discordRes.text();
      res.status(502).json({ error: 'Discord rejected: ' + errText.substring(0, 200) });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
