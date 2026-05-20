const express = require('express');
const axios = require('axios');
const itemService = require('../services/itemService');
const inviteService = require('../services/inviteService');

function makeItemsRouter(db, requireAuth, requireTenant, io) {
  const router = express.Router();

  router.get('/app', requireAuth, requireTenant, async (req, res) => {
    const sortBy = req.query.sortBy || 'item';

    // allWorkspaces removido daqui — carregado lazy via GET /workspace/list
    // quando o dropdown abre, reduzindo conexões por request de 3 → 2
    const [items, members, currentWorkspace] = await Promise.all([
      itemService.listItems(req.tenantId, sortBy, db),
      db('tenant_members')
        .join('users', 'users.id', 'tenant_members.user_id')
        .where('tenant_members.tenant_id', req.tenantId)
        .select('users.id', 'users.name', 'users.email', 'tenant_members.role')
        .orderBy('tenant_members.joined_at', 'asc'),
      db('tenants').where({ id: req.tenantId }).first(), // lookup por PK — O(1)
    ]);

    const userRole = members.find((m) => m.id === req.user.sub)?.role;

    res.render('lista', {
      items, sortBy, user: req.user, tenantId: req.tenantId,
      members, currentWorkspace, userRole,
    });
  });

  router.post('/app/add', requireAuth, requireTenant, async (req, res) => {
    const { item } = req.body;
    if (!item || !item.trim()) return res.status(400).json({ error: 'item required' });

    const newItem = await itemService.addItem(req.tenantId, item.trim(), db);
    io.to(req.tenantId).emit('item-added', newItem);

    if (req.accepts('html')) return res.redirect('/app');
    return res.status(201).json(newItem);
  });

  router.post('/app/check', requireAuth, requireTenant, async (req, res) => {
    const { id, checked } = req.body;
    const isChecked = checked === 'on';
    await itemService.checkItem(req.tenantId, id, isChecked, db);
    io.to(req.tenantId).emit('item-checked', { id, checked: isChecked });

    if (req.accepts('html')) return res.redirect('/app');
    return res.status(200).json({ ok: true });
  });

  router.post('/app/clear-checked', requireAuth, requireTenant, async (req, res) => {
    await itemService.archiveChecked(req.tenantId, db);
    io.to(req.tenantId).emit('items-cleared'); // evento correto — cliente escuta 'items-cleared'

    const fqdnUrl = process.env.FQDN_URL;
    if (fqdnUrl) {
      try {
        await axios.get(fqdnUrl, {
          auth: { username: process.env.FQDN_USER, password: process.env.FQDN_PASSWORD },
          validateStatus: (s) => s >= 200 && s < 500,
        });
      } catch {
        // webhook failure is non-fatal
      }
    }

    if (req.accepts('html')) return res.redirect('/app');
    return res.status(200).json({ ok: true });
  });

  router.patch('/app/item/:id', requireAuth, requireTenant, async (req, res) => {
    const { id } = req.params;
    const { quantity, is_critical } = req.body;

    const updates = {};
    if (quantity !== undefined) updates.quantity = quantity.trim() || null;
    if (is_critical !== undefined) updates.is_critical = !!is_critical;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no updates provided' });
    }

    await itemService.updateItem(req.tenantId, id, updates, db);
    io.to(req.tenantId).emit('item-updated', { id, ...updates });
    return res.status(200).json({ ok: true });
  });

  router.post('/app/check-archived', requireAuth, requireTenant, async (req, res) => {
    const items = await itemService.listArchived(req.tenantId, db);
    return res.status(200).json(items);
  });

  router.delete('/app/remove-archived', requireAuth, requireTenant, async (req, res) => {
    await itemService.deleteArchived(req.tenantId, db);
    return res.status(200).json({ ok: true });
  });

  router.post('/workspace/invite', requireAuth, requireTenant, async (req, res) => {
    // tenant_members sem FORCE RLS — consulta direta OK
    const member = await db('tenant_members')
      .where({ tenant_id: req.tenantId, user_id: req.user.sub })
      .first();

    if (!member || member.role !== 'owner') return res.status(403).json({ code: 'FORBIDDEN' });

    const token = await inviteService.createInvite(req.tenantId, req.user.sub, db);
    const appUrl = process.env.APP_URL || /* istanbul ignore next */ 'http://localhost:3000';
    return res.status(200).json({ inviteUrl: `${appUrl}/join?token=${token}` });
  });

  return router;
}

module.exports = makeItemsRouter;
