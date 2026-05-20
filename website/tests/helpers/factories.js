const authService = require('../../services/authService');

async function createTenant(db, overrides = {}) {
  const name = overrides.name || 'Test Tenant';
  const slug = overrides.slug || `test-tenant-${Date.now()}`;
  const [tenant] = await db('tenants').insert({ name, slug, ...overrides }).returning('*');
  return tenant;
}

async function createUser(db, overrides = {}) {
  const defaults = {
    google_id: `google-${Date.now()}-${Math.random()}`,
    email: `user-${Date.now()}@example.com`,
    name: 'Test User',
  };
  const [user] = await db('users').insert({ ...defaults, ...overrides }).returning('*');
  return user;
}

async function addMember(db, tenantId, userId, role = 'member') {
  const [member] = await db('tenant_members')
    .insert({ tenant_id: tenantId, user_id: userId, role })
    .returning('*');
  return member;
}

async function createItem(db, tenantId, overrides = {}) {
  const defaults = { item: 'Test Item', checked: false, archived: false };
  const [item] = await db('items')
    .insert({ tenant_id: tenantId, ...defaults, ...overrides })
    .returning('*');
  return item;
}

async function createInvite(db, tenantId, createdBy, overrides = {}) {
  const token = require('crypto').randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const [invite] = await db('invites')
    .insert({ tenant_id: tenantId, token, created_by: createdBy, expires_at: expiresAt, ...overrides })
    .returning('*');
  return invite;
}

function makeAccessToken(payload) {
  return authService.signAccessToken(payload);
}

async function makeRefreshToken(db, userId) {
  const token = authService.generateRefreshToken();
  await authService.saveRefreshToken(userId, token, db);
  return token;
}

module.exports = {
  createTenant,
  createUser,
  addMember,
  createItem,
  createInvite,
  makeAccessToken,
  makeRefreshToken,
};
