require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const { makeRequireTenant } = require('../../../middleware/auth');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;
let requireTenant;

beforeAll(async () => {
  db = getTestDb();
  requireTenant = makeRequireTenant(db);
});

beforeEach(async () => { await truncateAll(); });

afterAll(async () => { await destroyDb(); });

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('requireTenant — no tenantId in JWT', () => {
  test('returns 403', async () => {
    const req = { user: { sub: 'uid', email: 'a@b.com' } };
    const res = mockRes();
    const next = jest.fn();
    await requireTenant(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ code: 'FORBIDDEN' });
  });
});

describe('requireTenant — valid member', () => {
  test('injects req.tenantId and calls next()', async () => {
    const [tenant] = await db('tenants').insert({ name: 'RT', slug: 'rt-slug' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'grt1', email: 'rt@t.com' }).returning('*');
    // tenant_members sem FORCE RLS — insert direto funciona
    await db('tenant_members').insert({ tenant_id: tenant.id, user_id: user.id, role: 'member' });

    const req = { user: { sub: user.id, email: user.email, tenantId: tenant.id } };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe(tenant.id);
    expect(req.db).toBe(db);
  });
});

describe('requireTenant — not a member', () => {
  test('returns 403', async () => {
    const [tenant] = await db('tenants').insert({ name: 'NT', slug: 'nt-slug' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gnt1', email: 'nt@t.com' }).returning('*');

    const req = { user: { sub: user.id, email: user.email, tenantId: tenant.id } };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireTenant — tenant does not exist', () => {
  test('returns 403', async () => {
    const [user] = await db('users').insert({ google_id: 'gne1', email: 'ne@t.com' }).returning('*');
    const req = { user: { sub: user.id, email: user.email, tenantId: '00000000-0000-0000-0000-000000000000' } };
    const res = mockRes();
    const next = jest.fn();

    await requireTenant(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireTenant — DB error', () => {
  test('returns 403 when DB throws', async () => {
    const brokenDb = Object.assign(
      () => ({ where: () => ({ first: () => Promise.reject(new Error('DB error')) }) }),
      { fn: { now: () => new Date() } }
    );
    const rt = makeRequireTenant(brokenDb);
    const req = { user: { sub: 'uid', email: 'a@b.com', tenantId: '00000000-0000-0000-0000-000000000001' } };
    const res = mockRes();
    const next = jest.fn();

    await rt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
