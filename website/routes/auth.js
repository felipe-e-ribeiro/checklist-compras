const express = require('express');
const passport = require('passport');
const authService = require('../services/authService');
const { COOKIE_OPTS } = require('../middleware/auth');
const { anonymizeUser, exportUserData } = require('../services/userService');

async function _handleOAuthCallback(req, res, db) {
  const user = req.user;
  const accessToken = authService.signAccessToken({ sub: user.id, email: user.email });
  const refreshToken = authService.generateRefreshToken();
  await authService.saveRefreshToken(user.id, refreshToken, db);
  res.cookie('access_token', accessToken, COOKIE_OPTS);
  res.cookie('refresh_token', refreshToken, COOKIE_OPTS);
  res.redirect('/select-workspace');
}

function makeAuthRouter(db) {
  const router = express.Router();

  router.get('/login', (req, res) => res.render('login', { query: req.query }));

  router.get('/privacy', (_req, res) => res.render('privacy'));

  router.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
  );

  router.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    /* istanbul ignore next */ (req, res) => _handleOAuthCallback(req, res, db)
  );

  router.post('/auth/refresh', async (req, res) => {
    const refreshToken = req.cookies && req.cookies.refresh_token;
    const accessToken = req.cookies && req.cookies.access_token;

    if (!refreshToken) return res.status(401).json({ code: 'UNAUTHORIZED' });

    let decoded = null;
    if (accessToken) {
      try {
        decoded = authService.verifyAccessToken(accessToken);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          decoded = authService.decodeWithoutVerify(accessToken);
        }
      }
    }

    if (!decoded) return res.status(401).json({ code: 'UNAUTHORIZED' });

    const userId = decoded.sub;
    const record = await authService.validateRefreshToken(refreshToken, userId, db);
    if (!record) return res.status(401).json({ code: 'UNAUTHORIZED' });

    const { newToken } = await authService.rotateRefreshToken(record, userId, db);
    const user = await db('users').where({ id: userId }).first();
    const payload = { sub: user.id, email: user.email };
    if (decoded.tenantId) payload.tenantId = decoded.tenantId;

    const newAccessToken = authService.signAccessToken(payload);
    res.cookie('access_token', newAccessToken, COOKIE_OPTS);
    res.cookie('refresh_token', newToken, COOKIE_OPTS);
    res.status(200).json({ ok: true });
  });

  router.post('/auth/logout', async (req, res) => {
    const refreshToken = req.cookies && req.cookies.refresh_token;
    const accessToken = req.cookies && req.cookies.access_token;

    if (refreshToken && accessToken) {
      try {
        const decoded = authService.verifyAccessToken(accessToken);
        const record = await authService.validateRefreshToken(refreshToken, decoded.sub, db);
        if (record) await db('refresh_tokens').where({ id: record.id }).update({ revoked_at: db.fn.now() });
      } catch {
        // expired or invalid token — still clear cookies
      }
    }

    res.clearCookie('access_token', COOKIE_OPTS);
    res.clearCookie('refresh_token', COOKIE_OPTS);
    res.redirect('/login');
  });

  // ── Exportar dados (RGPD Art. 20 — portabilidade) ───────────────────
  router.get('/account/export', async (req, res) => {
    const accessToken = req.cookies && req.cookies.access_token;
    if (!accessToken) return res.redirect('/login');
    try {
      const payload = authService.verifyAccessToken(accessToken);
      const data = await exportUserData(payload.sub, db);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="meus-dados.json"');
      return res.send(JSON.stringify(data, null, 2));
    } catch {
      return res.redirect('/login');
    }
  });

  // ── Deletar conta (RGPD Art. 17 — direito ao esquecimento) ──────────
  router.post('/account/delete', async (req, res) => {
    const accessToken = req.cookies && req.cookies.access_token;
    if (!accessToken) return res.redirect('/login');
    try {
      const payload = authService.verifyAccessToken(accessToken);
      await anonymizeUser(payload.sub, db);
    } catch {
      // token expirado — tentar pelo refresh
    }
    res.clearCookie('access_token', COOKIE_OPTS);
    res.clearCookie('refresh_token', COOKIE_OPTS);
    return res.redirect('/login?deleted=1');
  });

  return router;
}

makeAuthRouter._handleOAuthCallback = _handleOAuthCallback;
module.exports = makeAuthRouter;
