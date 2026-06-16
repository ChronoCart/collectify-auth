export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Map short codes back to full retailer names
const RETAILER_MAP = {
  'TGT': 'Target',
  'WMT': 'Walmart',
  'CST': 'Costco',
  'SAM': "Sam's Club",
  'PKC': 'Pokemon Center',
  // Also handle full names in case they come through
  'Target': 'Target',
  'Walmart': 'Walmart',
  'Costco': 'Costco',
  'PokemonCenter': 'Pokemon Center',
  'SamsClub': "Sam's Club",
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_SLOTS_WEBHOOK_SECRET;

  let event;
  try {
    const crypto = await import('crypto');
    const parts = sig.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});

    const signedPayload = `${parts.t}.${rawBody.toString()}`;
    const expectedSig = crypto.default
      .createHmac('sha256', webhookSecret)
      .update(signedPayload)
      .digest('hex');

    if (expectedSig !== parts.v1) {
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

  // client_reference_id format: DISCORDID_SHORTCODE
  // e.g. 700203316281475082_PKC
  const ref = session.client_reference_id || '';
  const underscoreIdx = ref.indexOf('_');

  if (underscoreIdx === -1) {
    console.error('Invalid client_reference_id format:', ref);
    return res.status(200).json({ received: true, warning: 'Invalid ref format' });
  }

  const discordId = ref.slice(0, underscoreIdx);
  const retailerRaw = ref.slice(underscoreIdx + 1);
  const retailer = RETAILER_MAP[retailerRaw] || retailerRaw;
  const username = session.customer_details?.name || '';

  const amountPaid = session.amount_total || 0;
  const slotsToAdd = Math.max(1, Math.floor(amountPaid / 1000));

  console.log(`💰 [SLOTS] ${discordId} bought ${slotsToAdd} slot(s) for ${retailer} (raw: ${retailerRaw})`);

  try {
    const scriptUrl = process.env.CF_MEMBERS_SCRIPT_URL;
    if (!scriptUrl) throw new Error('CF_MEMBERS_SCRIPT_URL not set');

    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId, username, retailer, slots: slotsToAdd }),
      redirect: 'follow',
    });

    const result = await response.json();
    console.log(`✅ [SLOTS] Sheet updated:`, result);
  } catch (err) {
    console.error('Failed to update sheet:', err.message);
  }

  res.status(200).json({ received: true });
}
