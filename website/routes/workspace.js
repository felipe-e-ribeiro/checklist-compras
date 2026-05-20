const express = require('express');
const authService = require('../services/authService');
const inviteService = require('../services/inviteService');
const { COOKIE_OPTS } = require('../middleware/auth');

const OWNED_LIMIT = 3;
const TOTAL_LIMIT = 9;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

async function getOwnedCount(userId, db) {
  const [{ count }] = await db('tenant_members')
    .where({ user_id: userId, role: 'owner' })
    .count('* as count');
  return parseInt(count);
}

async function getTotalCount(userId, db) {
  const [{ count }] = await db('tenant_members')
    .where({ user_id: userId })
    .count('* as count');
  return parseInt(count);
}

function makeWorkspaceRouter(db, requireAuth, requireTenant) {
  const router = express.Router();

  // ── Seleção inicial de workspace (pós-login) ───────────────────────
  router.get('/select-workspace', requireAuth, async (req, res) => {
    const memberships = await db('tenant_members')
      .join('tenants', 'tenants.id', 'tenant_members.tenant_id')
      .where('tenant_members.user_id', req.user.sub)
      .select('tenants.*', 'tenant_members.role');

    if (memberships.length === 0) return res.redirect('/create-workspace');
    if (memberships.length === 1) {
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

  // ── Lista workspaces do usuário (lazy — chamado só ao abrir dropdown) ─
  router.get('/workspace/list', requireAuth, async (req, res) => {
    const workspaces = await db('tenant_members')
      .join('tenants', 'tenants.id', 'tenant_members.tenant_id')
      .where('tenant_members.user_id', req.user.sub)
      .select('tenants.id', 'tenants.name', 'tenant_members.role')
      .orderBy('tenants.name', 'asc');

    const ownedCount = workspaces.filter((w) => w.role === 'owner').length;
    return res.json({ workspaces, ownedCount });
  });

  // ── Troca de workspace in-app (dropdown) ──────────────────────────
  router.post('/workspace/switch', requireAuth, async (req, res) => {
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

  // ── Criar workspace ───────────────────────────────────────────────
  router.get('/create-workspace', requireAuth, (req, res) => {
    res.render('create-workspace', { user: req.user });
  });

  router.post('/create-workspace', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

    const ownedCount = await getOwnedCount(req.user.sub, db);
    if (ownedCount >= OWNED_LIMIT) {
      return res.status(403).json({ code: 'WORKSPACE_LIMIT_REACHED' });
    }

    const slug = `${slugify(name)}-${Date.now()}`;
    const [tenant] = await db('tenants').insert({ name: name.trim(), slug }).returning('*');

    await db('tenant_members').insert({ tenant_id: tenant.id, user_id: req.user.sub, role: 'owner' });

    const newToken = authService.signAccessToken({
      sub: req.user.sub,
      email: req.user.email,
      tenantId: tenant.id,
    });
    res.cookie('access_token', newToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  // ── Aceitar convite ───────────────────────────────────────────────
  router.get('/join', requireAuth, async (req, res) => {
    const { token } = req.query;
    const invite = await inviteService.validateInvite(token, db);
    if (!invite) return res.status(400).render('error', { message: 'Convite inválido ou expirado.' });

    const totalCount = await getTotalCount(req.user.sub, db);
    if (totalCount >= TOTAL_LIMIT) {
      return res.render('error', {
        message: `Você já participa de ${TOTAL_LIMIT} workspaces, o máximo permitido.`,
      });
    }

    const tenantId = await inviteService.acceptInvite(token, req.user.sub, db);
    const newToken = authService.signAccessToken({
      sub: req.user.sub,
      email: req.user.email,
      tenantId,
    });
    res.cookie('access_token', newToken, COOKIE_OPTS);
    return res.redirect('/app');
  });

  // ── Revogar membro (owner only) ───────────────────────────────────
  router.delete('/workspace/members/:userId', requireAuth, requireTenant, async (req, res) => {
    const { userId } = req.params;

    // Verificar que requester é owner (sempre do banco, nunca do JWT)
    const requester = await db('tenant_members')
      .where({ tenant_id: req.tenantId, user_id: req.user.sub })
      .first();
    if (!requester || requester.role !== 'owner') {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    // Não pode se auto-revogar
    if (userId === req.user.sub) {
      return res.status(400).json({ code: 'CANNOT_REVOKE_SELF' });
    }

    // Verificar que o alvo existe e não é owner
    const target = await db('tenant_members')
      .where({ tenant_id: req.tenantId, user_id: userId })
      .first();
    if (!target) return res.status(404).json({ code: 'MEMBER_NOT_FOUND' });
    if (target.role === 'owner') return res.status(400).json({ code: 'CANNOT_REVOKE_OWNER' });

    await db('tenant_members')
      .where({ tenant_id: req.tenantId, user_id: userId })
      .del();

    return res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = makeWorkspaceRouter;
