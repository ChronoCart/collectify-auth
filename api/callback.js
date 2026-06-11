export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect(`${process.env.FRONTEND_URL}?error=token_failed`);

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${process.env.GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const member = await memberRes.json();

    const isAutocheckout = member.roles && member.roles.includes('1422912777428664431');

    const params = new URLSearchParams({
      id: user.id,
      username: user.username,
      avatar: user.avatar || '',
      paid: isAutocheckout ? '1' : '0',
      plan: 'Autocheckout',
    });

    res.redirect(`${process.env.FRONTEND_URL}/collectify-dashboard.html?${params}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL}?error=server_error`);
  }
}
