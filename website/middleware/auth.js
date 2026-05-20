const authService = require('../services/authService');

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
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
        const decoded = _decodeWithoutVerify(accessToken);
        return _tryRefresh(req, res, next, decoded, db);
      }
      return res.redirect('/auth/google');
    }
  };
}

async function _tryRefresh(req, res, next, decoded, db) {
  const refreshToken = req.cookies && req.cookies.refresh_token;
  if (!refreshToken || !decoded) {
    return res.redirect('/auth/google');
  }

  try {
    const userId = decoded.sub;
    const record = await authService.validateRefreshToken(refreshToken, userId, db);
    if (!record) return res.redirect('/auth/google');

    const { newToken } = await authService.rotateRefreshToken(record, userId, db);

    const user = await db('users').where({ id: userId }).first();
    const payload = { sub: user.id, email: user.email };
    if (decoded.tenantId) payload.tenantId = decoded.tenantId;

    const newAccessToken = authService.signAccessToken(payload);

    res.cookie('access_token', newAccessToken, COOKIE_OPTS);
    res.cookie('refresh_token', newToken, COOKIE_OPTS);

    req.user = authService.verifyAccessToken(newAccessToken);
    return next();
  } catch {
    return res.redirect('/auth/google');
  }
}

function _decodeWithoutVerify(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch {
    return null;
  }
}

function makeRequireTenant(db) {
  return async function requireTenant(req, res, next) {
    const tenantId = req.user && req.user.tenantId;
    if (!tenantId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    try {
      const trx = await db.transaction();
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);

      const member = await trx('tenant_members')
        .where({ tenant_id: tenantId, user_id: req.user.sub })
        .first();

      if (!member) {
        await trx.rollback();
        return res.status(403).json({ code: 'FORBIDDEN' });
      }

      req.tenantId = tenantId;
      req.db = trx;

      if (res.on) {
        res.on('finish', () => { if (!trx.isCompleted()) trx.commit(); });
        res.on('close', () => { if (!trx.isCompleted()) trx.rollback(); });
      }

      return next();
    } catch {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }
  };
}

module.exports = { makeRequireAuth, makeRequireTenant, COOKIE_OPTS };
