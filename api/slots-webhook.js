// ── Collectify Extra Slot Webhook  (collectify-auth.vercel.app/api/slots-webhook)
//
// Stripe sends checkout.session.completed after a slot purchase.
// client_reference_id format: "{discordUserId}_{retailerShort}"
//   e.g.  "1234567890123456789_TGT"
//
// This handler parses BOTH parts and tells the Apps Script which retailer
// got the slot, so the sheet records it correctly per-retailer.
//
// ENV VARS needed on Vercel:
//   STRIPE_SLOTS_WEBHOOK_SECRET=whsec_...   (from Stripe Webhooks dashboard)
//   CF_MEMBERS_SCRIPT_URL=https://script.google.com/macros/s/.../exec

import Stripe from 'stripe';

// Short code → full retailer name (must match RETAILERS in collectify-dashboard.html)
const RETAILER_SHORT_MAP = {
  TGT: 'Target',
  WMT: 'Walmart',
  PKC: 'Pokemon Center',
  SAM: "Sam's Club",
  CST: 'Costco',
};

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_SLOTS_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Missing STRIPE_SLOTS_WEBHOOK_SECRET' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: true });
  }

  const session = event.data.object;
  const clientRef = session.client_reference_id || '';

  // ── Parse "userId_retailerShort" ─────────────────────────────────────────
  // Split on the LAST underscore so Discord IDs (which don't contain _) are safe,
  // but short codes (TGT, WMT, etc.) are never confused with user IDs.
  const lastUnderscore = clientRef.lastIndexOf('_');
  if (lastUnderscore === -1) {
    console.error('slots-webhook: client_reference_id missing underscore —', clientRef);
    return res.status(200).json({ received: true, error: 'bad_client_reference_id' });
  }

  const discordUserId = clientRef.slice(0, lastUnderscore);
  const retailerShort = clientRef.slice(lastUnderscore + 1);
  const retailerName  = RETAILER_SHORT_MAP[retailerShort];

  if (!discordUserId) {
    console.error('slots-webhook: could not extract discordUserId from', clientRef);
    return res.status(200).json({ received: true, error: 'missing_discord_id' });
  }
  if (!retailerName) {
    console.error(`slots-webhook: unknown retailer short code "${retailerShort}" from`, clientRef);
    return res.status(200).json({ received: true, error: 'unknown_retailer' });
  }

  const customerEmail = session.customer_details?.email || '';
  const amountPaid    = (session.amount_total || 0) / 100; // cents → dollars
  const sessionId     = session.id;

  console.log(`slots-webhook: user=${discordUserId} retailer=${retailerName} amount=$${amountPaid} session=${sessionId}`);

  // ── Notify Apps Script ────────────────────────────────────────────────────
  const scriptUrl = process.env.CF_MEMBERS_SCRIPT_URL;
  if (!scriptUrl) {
    console.error('slots-webhook: CF_MEMBERS_SCRIPT_URL not set');
    return res.status(500).json({ error: 'CF_MEMBERS_SCRIPT_URL missing' });
  }

  try {
    const params = new URLSearchParams({
      action:        'add_slot',
      discord_id:    discordUserId,
      retailer:      retailerName,      // ← THE FIX: now passes full retailer name
      retailer_short: retailerShort,
      email:         customerEmail,
      amount:        String(amountPaid),
      session_id:    sessionId,
    });

    const scriptResp = await fetch(`${scriptUrl}?${params}`, { method: 'GET' });
    const scriptText = await scriptResp.text();
    let scriptJson = {};
    try { scriptJson = JSON.parse(scriptText); } catch {}

    if (!scriptJson.ok) {
      console.error('slots-webhook: Apps Script returned error —', scriptText);
      return res.status(200).json({ received: true, script_error: scriptText });
    }

    console.log(`slots-webhook: ✅ slot credited — ${retailerName} for ${discordUserId}`);
    return res.status(200).json({ received: true, ok: true, retailer: retailerName });
  } catch (err) {
    console.error('slots-webhook: fetch to Apps Script failed —', err.message);
    return res.status(200).json({ received: true, script_fetch_error: err.message });
  }
}
