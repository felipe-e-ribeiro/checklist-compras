const jwt = require('jsonwebtoken');
const authService = require('../services/authService');

const COOKIE_OPTS = {
  httpOnly: true,
  secure: /* istanbul ignore next */ process.env.NODE_ENV === 'production',
  sameSite: 'strict',
};

function makeRequireAuth(db) {
  return async function requireAuth(req, res, next) {
    const accessToken = req.cookies && req.cookies.access_token;

    if (!accessToken) {
      return _tryRefresh(req, res, next, null, db);
    }

    try {
      req.user = authService.verifyAccessToken(accessToken);
      return next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return _tryRefresh(req, res, next, jwt.decode(accessToken), db);
      }
      return res.redirect('/auth/google');
    }
  };
}

async function _tryRefresh(req, res, next, decoded, db) {
  const refreshToken = req.cookies && req.cookies.refresh_token;
  if (!refreshToken || !decoded) return res.redirect('/auth/google');

  try {
    const userId = decoded.sub;
    const record = await authService.validateRefreshToken(refreshToken, userId, db);
    if (!record) return res.redirect('/auth/google');

    const { newToken } = await authService.rotateRefreshToken(record, userId, db);
    const user = await db('users').where({ id: userId }).first();
    const payload = { sub: user.id, email: user.email };
    if (decoded.tenantId) payload.tenantId = decoded.tenantId;

    const newAccess = authService.signAccessToken(payload);
    res.cookie('access_token', newAccess, COOKIE_OPTS);
    res.cookie('refresh_token', newToken, COOKIE_OPTS);
    req.user = authService.verifyAccessToken(newAccess);
    return next();
  } catch {
    return res.redirect('/auth/google');
  }
}

function makeRequireTenant(db) {
  return async function requireTenant(req, res, next) {
    const tenantId = req.user && req.user.tenantId;
    if (!tenantId) return res.status(403).json({ code: 'FORBIDDEN' });

    try {
      const member = await db('tenant_members')
        .where({ tenant_id: tenantId, user_id: req.user.sub })
        .first();

      if (!member) return res.status(403).json({ code: 'FORBIDDEN' });

      req.tenantId = tenantId;
      req.db = db;
      return next();
    } catch {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }
  };
}

module.exports = { makeRequireAuth, makeRequireTenant, COOKIE_OPTS };
