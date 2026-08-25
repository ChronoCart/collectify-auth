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

  // Blacklist gate — a banned member is fully locked out of the Collectify dashboard. The bot
  // owns the ban list; we ask it before assembling any data. Fail-OPEN on a bot outage: better
  // to let everyone through briefly than to lock out every paying member if the bot is down.
  try {
    const botUrl = process.env.CHECKOUT_BOT_URL;
    const botSecret = process.env.CHECKOUT_BOT_SECRET;
    if (botUrl && botSecret) {
      const br = await fetch(
        `${botUrl}/blacklist?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(botSecret)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (br.ok) {
        const bj = await br.json();
        if (bj && bj.blacklisted) {
          return res.status(403).json({ banned: true, reason: bj.reason || null });
        }
      }
    }
  } catch { /* fail open — see note above */ }

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
  // the payment's client_reference_id, and banked in the bot DB.
  //
  // ⚠️ MUST read the bot's /submissions route, NOT /bonus-slots. Collectify slots live in the
  // bot's SEPARATE `collectify_bonus_slots` ledger, and only /submissions returns them
  // (getCollectifyBonusSlots). /bonus-slots returns the CHRONOCART ledger (getBonusSlots), so
  // reading it here meant every Collectify slot purchase was credited in the DB but NEVER
  // surfaced on the dashboard. Both routes are behind the same secret gate and both are on the
  // bot's proxy allowlist, so this is a drop-in swap.
  async function fetchBonusSlots(discordId) {
    try {
      const botUrl = process.env.CHECKOUT_BOT_URL;
      const botSecret = process.env.CHECKOUT_BOT_SECRET;
      if (!botUrl || !botSecret) return {};
      const r = await fetch(
        `${botUrl}/submissions?id=${encodeURIComponent(discordId)}&secret=${encodeURIComponent(botSecret)}`,
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

    // ── Bandai (bot-only retailer) ── its sheet holds card data, so it is NOT published as
    // CSV like the other five. Pull the member's Bandai rows from the bot's PRIVATE /submissions
    // (authenticated) and merge them in, with card fields stripped before they reach the browser.
    try {
      const _botUrl = process.env.CHECKOUT_BOT_URL;
      const _botSecret = process.env.CHECKOUT_BOT_SECRET;
      if (_botUrl && _botSecret) {
        const _br = await fetch(`${_botUrl}/submissions?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(_botSecret)}`, { signal: AbortSignal.timeout(4000) });
        if (_br.ok) {
          const _bj = await _br.json();
          const _NAMES = { clfy_bandai: 'Bandai' };
          const _SENSITIVE = /card number|cvv|security code|full card|password/i;
          for (const _row of (_bj.submissions || [])) {
            const _name = _NAMES[String(_row.retailer || '').toLowerCase()];
            if (!_name) continue;
            const _clean = {};
            for (const [_k, _v] of Object.entries(_row)) {
              if (_k === 'retailer' || _k === 'rowIndex') continue;
              if (_SENSITIVE.test(_k)) continue;
              _clean[_k] = _v;
            }
            submissions.push({ _retailer: _name, ..._clean });
          }
        }
      }
    } catch (_e) { /* non-fatal: Bandai just will not show this cycle */ }

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
