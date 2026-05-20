require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const { makeRequireTenant } = require('../../../middleware/auth');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;
let requireTenant;

beforeAll(async () => {
  db = getTestDb();
  requireTenant = makeRequireTenant(db);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await destroyDb();
});

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    on: jest.fn(),
  };
}

describe('requireTenant — no tenantId in JWT', () => {
  test('returns 403', async () => {
    const req = { user: { sub: 'uid', email: 'a@b.com' }, cookies: {} };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ code: 'FORBIDDEN' });
  });
});

describe('requireTenant — user is a valid member', () => {
  test('injects req.tenantId, activates RLS, calls next()', async () => {
    const [tenant] = await db('tenants').insert({ name: 'RT', slug: 'rt-slug' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'grt1', email: 'rt@t.com' }).returning('*');
    await db.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
    await db('tenant_members').insert({ tenant_id: tenant.id, user_id: user.id, role: 'member' });
    await db.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');

    const req = {
      user: { sub: user.id, email: user.email, tenantId: tenant.id },
      cookies: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe(tenant.id);
    expect(req.db).toBeDefined();
  });
});

describe('requireTenant — user is not a member', () => {
  test('returns 403', async () => {
    const [tenant] = await db('tenants').insert({ name: 'NT', slug: 'nt-slug' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gnt1', email: 'nt@t.com' }).returning('*');

    const req = {
      user: { sub: user.id, email: user.email, tenantId: tenant.id },
      cookies: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ code: 'FORBIDDEN' });
  });
});

describe('requireTenant — tenant does not exist', () => {
  test('returns 403', async () => {
    const [user] = await db('users').insert({ google_id: 'gne1', email: 'ne@t.com' }).returning('*');
    const req = {
      user: { sub: user.id, email: user.email, tenantId: '00000000-0000-0000-0000-000000000000' },
      cookies: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
