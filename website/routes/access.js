const express = require('express');
const authService = require('../services/authService');
const { COOKIE_OPTS } = require('../middleware/auth');

function isEnabled() {
  return process.env.LOCAL_AUTH_ENABLED === 'true';
}

function makeAccessRouter(db) {
  const router = express.Router();

  router.get('/access', (_req, res) => {
    if (!isEnabled()) return res.status(404).end();
    res.render('access', { error: null });
  });

  router.post('/access', async (req, res) => {
    if (!isEnabled()) return res.status(404).end();

    const { username, password } = req.body;
    const validUser = process.env.LOCAL_AUTH_USER;
    const validPass = process.env.LOCAL_AUTH_PASSWORD;

    if (username !== validUser || password !== validPass) {
      return res.render('access', { error: 'Credenciais inválidas.' });
    }

    // Encontrar ou criar usuário local
    const googleId = `local:${username}`;
    let user = await db('users').where({ google_id: googleId }).first();
    if (!user) {
      [user] = await db('users')
        .insert({ google_id: googleId, email: `${username}@local.test`, name: username })
        .returning('*');
    }

    // Encontrar ou criar workspace
    let tenantId;
    const membership = await db('tenant_members').where({ user_id: user.id }).first();
    if (membership) {
      tenantId = membership.tenant_id;
    } else {
      const slug = `local-${username}-${Date.now()}`;
      const [tenant] = await db('tenants')
        .insert({ name: `${username} workspace`, slug })
        .returning('*');
      await db('tenant_members').insert({ tenant_id: tenant.id, user_id: user.id, role: 'owner' });
      tenantId = tenant.id;
    }

    const accessToken = authService.signAccessToken({ sub: user.id, email: user.email, tenantId });
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);

    res.cookie('access_token', accessToken, COOKIE_OPTS);
    res.cookie('refresh_token', refreshToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  return router;
}

module.exports = makeAccessRouter;
