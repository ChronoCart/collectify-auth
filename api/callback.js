export default async function handler(req, res) {
  const { code, state } = req.query;
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

    // Generate HMAC signature to prevent session spoofing
    const secret = process.env.TOKEN_SECRET || 'fallback_secret';
    const payload = `${user.id}:${user.username}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(payload);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const sigArray = Array.from(new Uint8Array(sigBuffer));
    const sig = sigArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const params = new URLSearchParams({
      id: user.id,
      username: user.username,
      avatar: user.avatar || '',
      paid: isAutocheckout ? '1' : '0',
      plan: 'Autocheckout',
      sig,
    });

        // A Whop sign-in finishing its Discord link (auth.js put whop.js's signed token in the state): record
    // whop_sub -> THIS Discord account on the bot, then hand the app the normal Discord session.
    const linking = typeof state === 'string' && state.startsWith('app.link.');
    if (linking) {
      try {
        const tok = state.slice('app.link.'.length); const [wp, wsig] = tok.split('.');
        const enc2 = new TextEncoder(); const k2 = await crypto.subtle.importKey('raw', enc2.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const want = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k2, enc2.encode(wp)))).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
        const w = want === wsig ? JSON.parse(Buffer.from(wp.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null;
        if (w && w.sub && Date.now() - (w.t || 0) < 30 * 60 * 1000) {
          const botUrl = process.env.BOT_URL || process.env.CHECKOUT_BOT_URL, botSecret = process.env.API_SECRET || process.env.CHECKOUT_BOT_SECRET;
          await fetch(`${botUrl}/clfy/whop-link?secret=${encodeURIComponent(botSecret)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sub: w.sub, discord_id: user.id, username: user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : '' }), signal: AbortSignal.timeout(8000) });
        }
      } catch (_) {}
    }
    if (state === 'app' || linking) return res.redirect(`collectify://auth?${params}`);
    res.redirect(`${process.env.FRONTEND_URL}/collectify-dashboard.html?${params}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL}?error=server_error`);
  }
}
