export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chronocart.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

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
    { name: 'Target', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9fJdY9cCJET97X0vzM1ART-t8jLotFXMakM_zQF9byL17VWycf_0ZKbcaazn5LL1i2UccWh0YHn_h/pub?output=csv' },
    { name: 'Costco', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ3wcryPD4M4xXJRUD6lt_Y867wzBHycsbFwP2HMxC8U9eu0VFUTWE_xYQAn8TKa2WmdIdmTP_aoxI4/pub?output=csv' },
    { name: "Sam's Club", url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRskIWk9E2kUYZonlAwTXthgKoGJ4a3rTyhAEI4rkQ7dBW5yc1PfoTm2AgKLQG5eqmIndEptlJ1my22/pub?output=csv' },
    { name: 'Walmart', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQF4PsT7-R3ROn2osAj91e1A2UbfL7nFolYbTQ1SS42_ahjR-MhjiAO22L4AkfpoCbY-OvePrFnafxl/pub?output=csv' },
    { name: 'Pokemon Center', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRDglOhfTV9fNy6hnuIwVvnKXkWtwvcMHi-o3Ldg7IrfSSNTCnBa8wZ-Tk_RZS-lfM5QIVPDuGrK93/pub?output=csv' },
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

  try {
    const retailerTexts = await Promise.all(RETAILERS.map(r => fetch(r.url).then(res => res.text())));
    const submissions = retailerTexts.map((text, i) => {
      const rows = parseCSV(text);
      return filterByUser(rows, id).map(row => ({ _retailer: RETAILERS[i].name, ...row }));
    }).flat();

    res.status(200).json({ submissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
}
