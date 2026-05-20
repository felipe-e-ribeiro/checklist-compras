require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const request = require('supertest');
const { createApp } = require('../../../server');
const authService = require('../../../services/authService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let app, db;

beforeAll(async () => {
  db = getTestDb();
  app = createApp(db);
});

beforeEach(async () => { await truncateAll(); });

afterAll(async () => { await destroyDb(); });

function authCookie(payload) {
  return `access_token=${authService.signAccessToken(payload)}`;
}

async function insertMember(tenantId, userId, role = 'member') {
  await db('tenant_members').insert({ tenant_id: tenantId, user_id: userId, role });
}

describe('GET /select-workspace — unauthenticated', () => {
  test('redirects to /auth/google', async () => {
    const res = await request(app).get('/select-workspace');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('GET /select-workspace — 0 tenants', () => {
  test('redirects to /create-workspace', async () => {
    const [user] = await db('users').insert({ google_id: 'gws1', email: 'ws0@t.com' }).returning('*');
    const res = await request(app).get('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/create-workspace');
  });
});

describe('GET /select-workspace — 1 tenant', () => {
  test('auto-selects and redirects to /app', async () => {
    const [tenant] = await db('tenants').insert({ name: 'One', slug: 'ws-one' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gws2', email: 'ws1@t.com' }).returning('*');
    await insertMember(tenant.id, user.id, 'owner');

    const res = await request(app).get('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
  });
});

describe('GET /select-workspace — N tenants', () => {
  test('renders workspace selection page', async () => {
    const [t1] = await db('tenants').insert({ name: 'T1', slug: 'ws-t1' }).returning('*');
    const [t2] = await db('tenants').insert({ name: 'T2', slug: 'ws-t2' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gws3', email: 'wsN@t.com' }).returning('*');
    await insertMember(t1.id, user.id, 'member');
    await insertMember(t2.id, user.id, 'owner');

    const res = await request(app).get('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('T1');
    expect(res.text).toContain('T2');
  });
});

describe('POST /select-workspace', () => {
  test('sets tenantId in JWT and redirects to /app', async () => {
    const [tenant] = await db('tenants').insert({ name: 'Sel', slug: 'ws-sel' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gws4', email: 'sel@t.com' }).returning('*');
    await insertMember(tenant.id, user.id, 'member');

    const res = await request(app).post('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ tenantId: tenant.id });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
    const cookieHeader = res.headers['set-cookie'] || [];
    expect(cookieHeader.some((c) => c.startsWith('access_token='))).toBe(true);
  });

  test('returns 403 if user is not a member', async () => {
    const [tenant] = await db('tenants').insert({ name: 'Nosel', slug: 'ws-nosel' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gws5', email: 'nosel@t.com' }).returning('*');

    const res = await request(app).post('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ tenantId: tenant.id });
    expect(res.status).toBe(403);
  });
});

describe('GET /create-workspace', () => {
  test('renders create-workspace page', async () => {
    const [user] = await db('users').insert({ google_id: 'gcw0', email: 'cw0@t.com' }).returning('*');
    const res = await request(app).get('/create-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Criar Ambiente');
  });
});

describe('POST /create-workspace', () => {
  test('creates tenant, adds owner, redirects to /app', async () => {
    const [user] = await db('users').insert({ google_id: 'gcw1', email: 'cw@t.com' }).returning('*');
    const res = await request(app).post('/create-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ name: 'Minha Lista' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    const tenant = await db('tenants').where({ name: 'Minha Lista' }).first();
    expect(tenant).toBeDefined();

    const member = await db('tenant_members')
      .where({ tenant_id: tenant.id, user_id: user.id, role: 'owner' }).first();
    expect(member).toBeDefined();
  });

  test('returns 400 if name is missing', async () => {
    const [user] = await db('users').insert({ google_id: 'gcw2', email: 'cw2@t.com' }).returning('*');
    const res = await request(app).post('/create-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /join — invite flow', () => {
  test('redirects to /login if not authenticated', async () => {
    const res = await request(app).get('/join?token=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });

  test('accepts valid invite and redirects to /app', async () => {
    const [tenant] = await db('tenants').insert({ name: 'Inv', slug: 'ws-inv' }).returning('*');
    const [owner] = await db('users').insert({ google_id: 'gio1', email: 'own@t.com' }).returning('*');
    const [invitee] = await db('users').insert({ google_id: 'gii1', email: 'inv@t.com' }).returning('*');

    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: tenant.id, token, created_by: owner.id,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    const res = await request(app).get(`/join?token=${token}`)
      .set('Cookie', [authCookie({ sub: invitee.id, email: invitee.email })]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    const membership = await db('tenant_members')
      .where({ tenant_id: tenant.id, user_id: invitee.id }).first();
    expect(membership).toBeDefined();
  });

  test('returns 400 for expired invite', async () => {
    const [tenant] = await db('tenants').insert({ name: 'Exp', slug: 'ws-exp' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'ge1', email: 'exp@t.com' }).returning('*');
    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: tenant.id, token, created_by: user.id,
      expires_at: new Date(Date.now() - 1000),
    });

    const res = await request(app).get(`/join?token=${token}`)
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(400);
  });
});

describe('POST /workspace/invite', () => {
  test('owner can generate invite link', async () => {
    const [tenant] = await db('tenants').insert({ name: 'InvGen', slug: 'ws-invgen' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gig1', email: 'ig@t.com' }).returning('*');
    await insertMember(tenant.id, user.id, 'owner');

    const res = await request(app).post('/workspace/invite')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: tenant.id })])
      .send();
    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).toContain('/join?token=');
  });

  test('non-owner gets 403', async () => {
    const [tenant] = await db('tenants').insert({ name: 'InvMem', slug: 'ws-invmem' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gim1', email: 'im@t.com' }).returning('*');
    await insertMember(tenant.id, user.id, 'member');

    const res = await request(app).post('/workspace/invite')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: tenant.id })])
      .send();
    expect(res.status).toBe(403);
  });
});
