export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_SLOTS_WEBHOOK_SECRET;

  // Verify Stripe signature
  let event;
  try {
    // Manual HMAC verification without stripe SDK
    const crypto = await import('crypto');
    const [, timestampPart, v1Part] = sig.split(',').reduce((acc, part) => {
      const [key, val] = part.split('=');
      acc[key === 't' ? 1 : key === 'v1' ? 2 : 0] = val;
      return acc;
    }, [null, null, null]);

    const signedPayload = `${timestampPart}.${rawBody.toString()}`;
    const expectedSig = crypto.default
      .createHmac('sha256', webhookSecret)
      .update(signedPayload)
      .digest('hex');

    if (expectedSig !== v1Part) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    event = JSON.parse(rawBody.toString());
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook error' });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  // Get Discord ID from client_reference_id (passed via Payment Link URL param)
  const discordId = session.client_reference_id;
  const email = session.customer_details?.email || '';
  const username = session.customer_details?.name || '';

  if (!discordId) {
    console.error('No Discord ID in client_reference_id — cannot credit slots');
    return res.status(200).json({ received: true, warning: 'No discordId' });
  }

  // Calculate slots purchased (1 slot per $10)
  const amountPaid = session.amount_total || 0;
  const slotsToAdd = Math.max(1, Math.floor(amountPaid / 1000)); // $10 = 1000 cents = 1 slot

  console.log(`💰 [SLOTS] ${discordId} purchased ${slotsToAdd} slot(s) — $${amountPaid / 100}`);

  // Call Apps Script to update the sheet
  try {
    const scriptUrl = process.env.CF_MEMBERS_SCRIPT_URL;
    if (!scriptUrl) throw new Error('CF_MEMBERS_SCRIPT_URL not set');

    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId, username, slots: slotsToAdd }),
      redirect: 'follow',
    });

    const result = await response.json();
    console.log(`✅ [SLOTS] Sheet updated:`, result);
  } catch (err) {
    console.error('Failed to update sheet:', err.message);
  }

  res.status(200).json({ received: true });
}
