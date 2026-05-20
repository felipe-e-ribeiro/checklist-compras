require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const inviteService = require('../../../services/inviteService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;

beforeAll(async () => {
  db = getTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await destroyDb();
});

async function setup() {
  const [tenant] = await db('tenants').insert({ name: 'T', slug: 'inv-t' }).returning('*');
  const [user] = await db('users').insert({ google_id: 'gi1', email: 'inv@t.com' }).returning('*');
  return { tenant, user };
}

describe('createInvite', () => {
  test('inserts invite and returns token', async () => {
    const { tenant, user } = await setup();
    const token = await inviteService.createInvite(tenant.id, user.id, db);
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);

    const row = await db('invites').where({ token }).first();
    expect(row).toBeDefined();
    expect(row.tenant_id).toBe(tenant.id);
    expect(row.created_by).toBe(user.id);
    expect(row.used_at).toBeNull();
    expect(new Date(row.expires_at) > new Date()).toBe(true);
  });
});

describe('validateInvite', () => {
  test('returns invite for valid token', async () => {
    const { tenant, user } = await setup();
    const token = await inviteService.createInvite(tenant.id, user.id, db);
    const invite = await inviteService.validateInvite(token, db);
    expect(invite).not.toBeNull();
    expect(invite.tenant_id).toBe(tenant.id);
  });

  test('returns null for nonexistent token', async () => {
    const result = await inviteService.validateInvite('no-such-token', db);
    expect(result).toBeNull();
  });

  test('returns null for expired token', async () => {
    const { tenant, user } = await setup();
    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: tenant.id,
      token,
      created_by: user.id,
      expires_at: new Date(Date.now() - 1000),
    });
    const result = await inviteService.validateInvite(token, db);
    expect(result).toBeNull();
  });

  test('returns null for already-used token', async () => {
    const { tenant, user } = await setup();
    const token = await inviteService.createInvite(tenant.id, user.id, db);
    await db('invites').where({ token }).update({ used_at: db.fn.now() });
    const result = await inviteService.validateInvite(token, db);
    expect(result).toBeNull();
  });
});

describe('acceptInvite', () => {
  test('marks invite as used and inserts tenant_member', async () => {
    const { tenant, user } = await setup();
    const [newUser] = await db('users').insert({ google_id: 'gi2', email: 'new@t.com' }).returning('*');
    const token = await inviteService.createInvite(tenant.id, user.id, db);

    const tenantId = await inviteService.acceptInvite(token, newUser.id, db);
    expect(tenantId).toBe(tenant.id);

    const used = await db('invites').where({ token }).first();
    expect(used.used_at).not.toBeNull();

    const membership = await db('tenant_members')
      .where({ tenant_id: tenant.id, user_id: newUser.id })
      .first();
    expect(membership).toBeDefined();
    expect(membership.role).toBe('member');
  });
});
