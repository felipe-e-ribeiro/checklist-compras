const express = require('express');
const authService = require('../services/authService');
const inviteService = require('../services/inviteService');
const { COOKIE_OPTS } = require('../middleware/auth');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function makeWorkspaceRouter(db, requireAuth) {
  const router = express.Router();

  router.get('/select-workspace', requireAuth, async (req, res) => {
    const memberships = await db('tenant_members')
      .join('tenants', 'tenants.id', 'tenant_members.tenant_id')
      .where('tenant_members.user_id', req.user.sub)
      .select('tenants.*', 'tenant_members.role');

    if (memberships.length === 0) return res.redirect('/create-workspace');
    if (memberships.length === 1) {
      const { id, email } = req.user;
      const newToken = authService.signAccessToken({
        sub: req.user.sub,
        email: req.user.email,
        tenantId: memberships[0].id,
      });
      res.cookie('access_token', newToken, COOKIE_OPTS);
      return res.redirect('/app');
    }
    return res.render('select-workspace', { tenants: memberships, user: req.user });
  });

  router.post('/select-workspace', requireAuth, async (req, res) => {
    const { tenantId } = req.body;
    const member = await db('tenant_members')
      .where({ tenant_id: tenantId, user_id: req.user.sub })
      .first();

    if (!member) return res.status(403).json({ code: 'FORBIDDEN' });

    const newToken = authService.signAccessToken({
      sub: req.user.sub,
      email: req.user.email,
      tenantId,
    });
    res.cookie('access_token', newToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  router.get('/create-workspace', requireAuth, (req, res) => {
    res.render('create-workspace', { user: req.user });
  });

  router.post('/create-workspace', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

    const slug = `${slugify(name)}-${Date.now()}`;
    const [tenant] = await db('tenants').insert({ name: name.trim(), slug }).returning('*');

    await db.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
    await db('tenant_members').insert({ tenant_id: tenant.id, user_id: req.user.sub, role: 'owner' });
    await db.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');

    const newToken = authService.signAccessToken({
      sub: req.user.sub,
      email: req.user.email,
      tenantId: tenant.id,
    });
    res.cookie('access_token', newToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  router.get('/join', requireAuth, async (req, res) => {
    const { token } = req.query;
    const invite = await inviteService.validateInvite(token, db);
    if (!invite) return res.status(400).render('error', { message: 'Convite inválido ou expirado.' });

    const tenantId = await inviteService.acceptInvite(token, req.user.sub, db);
    const newToken = authService.signAccessToken({
      sub: req.user.sub,
      email: req.user.email,
      tenantId,
    });
    res.cookie('access_token', newToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  return router;
}

module.exports = makeWorkspaceRouter;
