const express = require('express');
const passport = require('passport');
const authService = require('../services/authService');
const { COOKIE_OPTS } = require('../middleware/auth');

function makeAuthRouter(db) {
  const router = express.Router();

  router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

  router.get(
    '/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/auth/google' }),
    async (req, res) => {
      const { id, email } = req.user;
      const accessToken = authService.signAccessToken({ sub: id, email });
      const refreshToken = authService.generateRefreshToken();
      await authService.saveRefreshToken(id, refreshToken, db);
      res.cookie('access_token', accessToken, COOKIE_OPTS);
      res.cookie('refresh_token', refreshToken, COOKIE_OPTS);
      res.redirect('/select-workspace');
    }
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
          const parts = accessToken.split('.');
          if (parts.length === 3) {
            decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          }
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
        // expired token — still clear cookies
      }
    }

    res.clearCookie('access_token', COOKIE_OPTS);
    res.clearCookie('refresh_token', COOKIE_OPTS);
    res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = makeAuthRouter;
