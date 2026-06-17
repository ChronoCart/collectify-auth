export default async function handler(req, res) {
  const url = process.env.CF_SHEET_MEMBERS;
  if (!url) return res.status(200).json({ error: 'CF_SHEET_MEMBERS not set' });

  try {
    const text = await fetch(url).then(r => r.text());
    res.status(200).json({
      url,
      rawLength: text.length,
      first500chars: text.slice(0, 500),
    });
  } catch (err) {
    res.status(200).json({ error: err.message, url });
  }
}
