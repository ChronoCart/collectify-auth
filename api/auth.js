export default function handler(req, res) {
  const ref = req.query.ref || '';
  const redirect = req.query.redirect || 'dashboard';
  const state = ref ? `${redirect}:${ref}` : redirect;

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}
