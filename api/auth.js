export default function handler(req, res) {
  // ?redirect=app : the Collectify APP is signing in. Carried through Discord in `state` so callback.js
  // can send the session back to collectify://auth instead of the dashboard. Anything else = dashboard.
  // a Whop sign-in linking its Discord carries whop.js's signed token: state = 'app.link.<token>' (callback.js records the link)
  const link = req.query && /^[A-Za-z0-9_-]+\.[0-9a-f]{32}$/.test(String(req.query.link || '')) ? String(req.query.link) : '';
  const state = req.query && req.query.redirect === 'app' ? (link ? 'app.link.' + link : 'app') : 'web';
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}
