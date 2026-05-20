const crypto = require('crypto');

// Anonimizar usuário: substitui PII por valores genéricos irreversíveis.
// O google_id é mantido como-está (já é pseudônimo — não revela identidade real).
// Necessário para: direito ao esquecimento (RGPD Art. 17), deleção de conta.
async function anonymizeUser(userId, db) {
  // Hash curto do userId para gerar email único mas não rastreável
  const hash = crypto.createHash('sha256').update(userId).digest('hex').substring(0, 16);

  await db('users').where({ id: userId }).update({
    email:         `deleted-${hash}@anon.local`,
    name:          null,
    avatar_url:    null,
    anonymized_at: db.fn.now(),
  });

  // Revogar todas as sessões ativas
  await db('refresh_tokens')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now() });
}

// Exportar dados do usuário (RGPD Art. 20 — portabilidade)
async function exportUserData(userId, db) {
  const [user, items, tenants] = await Promise.all([
    db('users').where({ id: userId }).first(),
    db('items')
      .join('tenant_members as tm', function() {
        this.on('items.tenant_id', 'tm.tenant_id').andOn('tm.user_id', db.raw('?', [userId]));
      })
      .where({ 'items.archived': false })
      .select('items.item', 'items.checked', 'items.created_at'),
    db('tenant_members')
      .join('tenants', 'tenants.id', 'tenant_members.tenant_id')
      .where({ 'tenant_members.user_id': userId })
      .select('tenants.name', 'tenant_members.role', 'tenant_members.joined_at'),
  ]);

  return {
    exported_at:  new Date().toISOString(),
    account: {
      email:      user?.email,
      name:       user?.name,
      created_at: user?.created_at,
    },
    workspaces:  tenants,
    items:       items,
  };
}

module.exports = { anonymizeUser, exportUserData };
