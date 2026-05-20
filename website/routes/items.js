const express = require('express');
const axios = require('axios');
const itemService = require('../services/itemService');
const inviteService = require('../services/inviteService');

function makeItemsRouter(db, requireAuth, requireTenant, io) {
  const router = express.Router();

  router.get('/app', requireAuth, requireTenant, async (req, res) => {
    const sortBy = req.query.sortBy || 'item';
    const items = await itemService.listItems(req.tenantId, sortBy, db);
    res.render('lista', { items, sortBy, user: req.user, tenantId: req.tenantId });
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
    io.to(req.tenantId).emit('item-checked');

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

    return res.redirect('/app');
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
