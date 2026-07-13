const RATE_LIMIT = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 20;
  const entry = RATE_LIMIT.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { RATE_LIMIT.set(ip, { count: 1, start: now }); return true; }
  if (entry.count >= max) return false;
  entry.count++;
  RATE_LIMIT.set(ip, entry);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chronocart.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });
  const { id, sig, username } = req.query;
  if (!id || !sig) return res.status(400).json({ error: 'Missing params' });
  try {
    const secret = process.env.TOKEN_SECRET;
    const payload = `${id}:${username || ''}`;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = new Uint8Array(sig.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify('HMAC', cryptoKey, sigBytes, encoder.encode(payload));
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });
  } catch { return res.status(401).json({ error: 'Verification failed' }); }

  const RETAILERS = [
    { name: 'Target', url: process.env.SHEET_TARGET },
    { name: 'Costco', url: process.env.SHEET_COSTCO },
    { name: "Sam's Club", url: process.env.SHEET_SAMS },
    { name: 'Walmart', url: process.env.SHEET_WALMART },
    { name: 'Pokemon Center', url: process.env.SHEET_PKC },
  ];

  function parseCSVFull(text) {
    const rows = []; let row = [], cur = '', inQuotes = false;
    const normalized = text.replace(/\r/g, '');
    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      if (c === '"') {
        if (inQuotes && normalized[i+1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (c === ',' && !inQuotes) { row.push(cur); cur = ''; }
      else if (c === '\n' && !inQuotes) { row.push(cur); cur = ''; rows.push(row); row = []; }
      else { cur += c; }
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function parseCSV(text) {
    const cells = parseCSVFull(text);
    if (cells.length < 2) return [];
    const headers = cells[0].map(h => h.replace(/\n/g, ' ').trim());
    return cells.slice(1).map(vals => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    });
  }

  function filterByUser(rows, userId) {
    return rows.filter(row => {
      const dk = Object.keys(row).find(k => k.toLowerCase().includes('discord'));
      const m = (row[dk] || '').match(/\d{17,19}/);
      return dk && m && m[0] === userId;
    });
  }

  async function fetchCheckouts(discordId) {
    try {
      const botUrl = process.env.CHECKOUT_BOT_URL;
      const botSecret = process.env.CHECKOUT_BOT_SECRET;
      if (!botUrl || !botSecret) return [];
      const r = await fetch(
        `${botUrl}/checkouts?id=${encodeURIComponent(discordId)}&secret=${encodeURIComponent(botSecret)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }

  // Bonus slots the bot auto-credited from VERIFIED Stripe payments. The bot is the source of
  // truth now — every "Buy Extra Slot" checkout is watched, matched to the member+retailer via
  // the payment's client_reference_id, and banked in the bot DB. Same secret the checkouts call
  // uses; the bot's /bonus-slots route is behind the same secret gate.
  async function fetchBonusSlots(discordId) {
    try {
      const botUrl = process.env.CHECKOUT_BOT_URL;
      const botSecret = process.env.CHECKOUT_BOT_SECRET;
      if (!botUrl || !botSecret) return {};
      const r = await fetch(
        `${botUrl}/bonus-slots?id=${encodeURIComponent(discordId)}&secret=${encodeURIComponent(botSecret)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return {};
      const j = await r.json();
      return (j && j.bonusSlots) || {};
    } catch { return {}; }
  }

  // Normalize retailer name for matching (handles PKC, PokemonCenter, Pokemon Center etc)
  function normalizeRetailer(name) {
    return (name || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  const RETAILER_NORMALIZE = {
    'target': 'Target',
    'walmart': 'Walmart',
    'costco': 'Costco',
    'samsclub': "Sam's Club",
    'pokemoncenter': 'Pokemon Center',
    'pkc': 'Pokemon Center',
    'tgt': 'Target',
    'wmt': 'Walmart',
    'cst': 'Costco',
    'sam': "Sam's Club",
  };

  try {
    const [membersText, ...retailerTexts] = await Promise.all([
      process.env.CF_SHEET_MEMBERS
        ? fetch(process.env.CF_SHEET_MEMBERS).then(r => r.text()).catch(() => '')
        : Promise.resolve(''),
      ...RETAILERS.map(r => fetch(r.url).then(r2 => r2.text())),
    ]);

    const submissions = retailerTexts.map((text, i) =>
      filterByUser(parseCSV(text), id).map(row => ({ _retailer: RETAILERS[i].name, ...row }))
    ).flat();

    // Build bonus slots map from the LEGACY members sheet: { 'Target': 2, ... }
    // This is now a manual fallback only — see the bot merge below.
    const bonusSlots = {};
    if (membersText) {
      const memberRows = parseCSV(membersText);
      memberRows
        .filter(row => String(row['Discord ID'] || '').trim() === id)
        .forEach(row => {
          const rawRetailer = (row['Retailer'] || '').trim();
          const normalized = normalizeRetailer(rawRetailer);
          const retailerName = RETAILER_NORMALIZE[normalized] || rawRetailer;
          const slots = parseInt(row['Bonus Slots'] || '0', 10) || 0;
          if (retailerName && slots > 0) {
            bonusSlots[retailerName] = (bonusSlots[retailerName] || 0) + slots;
          }
        });
    }

    // The bot (auto-credited from verified Stripe payments) is authoritative. It WINS per
    // retailer over the legacy sheet, so a purchase is never double-counted against a stale
    // manual row. A retailer that only exists in the sheet still shows (manual grants survive).
    const botBonus = await fetchBonusSlots(id);
    for (const [retailer, n] of Object.entries(botBonus)) {
      if (n > 0) bonusSlots[retailer] = n;
    }

    const checkouts = await fetchCheckouts(id);

    res.status(200).json({ submissions, checkouts, bonusSlots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
}
