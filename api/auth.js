export default function handler(req, res) {
  // ?redirect=app : the Collectify APP is signing in. Carried through Discord in `state` so callback.js
  // can send the session back to collectify://auth instead of the dashboard. Anything else = dashboard.
  const state = req.query && req.query.redirect === 'app' ? 'app' : 'web';
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}
