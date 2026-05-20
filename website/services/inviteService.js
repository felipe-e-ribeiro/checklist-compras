const crypto = require('crypto');

const INVITE_EXPIRY_MS = 48 * 60 * 60 * 1000;

async function createInvite(tenantId, userId, db) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);
  await db('invites').insert({
    tenant_id: tenantId,
    token,
    created_by: userId,
    expires_at: expiresAt,
  });
  return token;
}

async function validateInvite(token, db) {
  const invite = await db('invites')
    .where({ token, used_at: null })
    .where('expires_at', '>', db.fn.now())
    .first();
  return invite || null;
}

async function acceptInvite(token, userId, db) {
  const invite = await validateInvite(token, db);
  if (!invite) return null;

  await db('invites').where({ id: invite.id }).update({ used_at: db.fn.now() });
  await db('tenant_members').insert({
    tenant_id: invite.tenant_id,
    user_id: userId,
    role: 'member',
  });
  return invite.tenant_id;
}

module.exports = { createInvite, validateInvite, acceptInvite };
