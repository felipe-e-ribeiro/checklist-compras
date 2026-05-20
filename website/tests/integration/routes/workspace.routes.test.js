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
function parseCookies(res) {
  const cookies = {};
  (res.headers['set-cookie'] || []).forEach((c) => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    cookies[k.trim()] = v ? v.trim() : '';
  });
  return cookies;
}
async function insertMember(tenantId, userId, role = 'member') {
  await db('tenant_members').insert({ tenant_id: tenantId, user_id: userId, role });
}
async function createTenantWithMember(userId, role = 'owner', suffix = '') {
  const slug = `t-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`;
  const [tenant] = await db('tenants').insert({ name: slug, slug }).returning('*');
  await insertMember(tenant.id, userId, role);
  return tenant;
}

// ── GET /select-workspace ─────────────────────────────────────────────────────

describe('GET /select-workspace — unauthenticated', () => {
  test('redirects to /login', async () => {
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
    const [user] = await db('users').insert({ google_id: 'gws2', email: 'ws1@t.com' }).returning('*');
    const tenant = await createTenantWithMember(user.id, 'owner');
    const res = await request(app).get('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
  });
});

describe('GET /select-workspace — N tenants', () => {
  test('renders workspace selection page', async () => {
    const [user] = await db('users').insert({ google_id: 'gws3', email: 'wsN@t.com' }).returning('*');
    await createTenantWithMember(user.id, 'member');
    await createTenantWithMember(user.id, 'owner');
    const res = await request(app).get('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(200);
  });
});

// ── POST /select-workspace ────────────────────────────────────────────────────

describe('POST /select-workspace', () => {
  test('sets tenantId in JWT and redirects to /app', async () => {
    const [user] = await db('users').insert({ google_id: 'gws4', email: 'sel@t.com' }).returning('*');
    const tenant = await createTenantWithMember(user.id, 'member');
    const res = await request(app).post('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ tenantId: tenant.id });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
    expect(parseCookies(res).access_token).toBeDefined();
  });

  test('returns 403 if user is not a member', async () => {
    const [tenant] = await db('tenants').insert({ name: 'X', slug: 'nosel-x' }).returning('*');
    const [user] = await db('users').insert({ google_id: 'gws5', email: 'nosel@t.com' }).returning('*');
    const res = await request(app).post('/select-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ tenantId: tenant.id });
    expect(res.status).toBe(403);
  });
});

// ── POST /workspace/switch ────────────────────────────────────────────────────

describe('POST /workspace/switch', () => {
  test('switches active workspace and redirects to /app', async () => {
    const [user] = await db('users').insert({ google_id: 'gsw1', email: 'sw@t.com' }).returning('*');
    const t1 = await createTenantWithMember(user.id, 'owner');
    const t2 = await createTenantWithMember(user.id, 'member');
    const res = await request(app).post('/workspace/switch')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: t1.id })])
      .send({ tenantId: t2.id });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
    expect(parseCookies(res).access_token).toBeDefined();
  });

  test('returns 403 if user is not a member of target workspace', async () => {
    const [user] = await db('users').insert({ google_id: 'gsw2', email: 'swno@t.com' }).returning('*');
    const t1 = await createTenantWithMember(user.id, 'owner');
    const [t2] = await db('tenants').insert({ name: 'Other', slug: 'sw-other' }).returning('*');
    const res = await request(app).post('/workspace/switch')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: t1.id })])
      .send({ tenantId: t2.id });
    expect(res.status).toBe(403);
  });
});

// ── GET /create-workspace ─────────────────────────────────────────────────────

describe('GET /create-workspace', () => {
  test('renders create-workspace page', async () => {
    const [user] = await db('users').insert({ google_id: 'gcw0', email: 'cw0@t.com' }).returning('*');
    const res = await request(app).get('/create-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Criar Ambiente');
  });
});

// ── POST /create-workspace ────────────────────────────────────────────────────

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

  test('returns 403 when user already owns 3 workspaces', async () => {
    const [user] = await db('users').insert({ google_id: 'gcwlim', email: 'cwlim@t.com' }).returning('*');
    for (let i = 0; i < 3; i++) await createTenantWithMember(user.id, 'owner');
    const res = await request(app).post('/create-workspace')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })])
      .send({ name: 'Quarto' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WORKSPACE_LIMIT_REACHED');
  });
});

// ── GET /join ─────────────────────────────────────────────────────────────────

describe('GET /join — invite flow', () => {
  test('redirects to /login if not authenticated', async () => {
    const res = await request(app).get('/join?token=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });

  test('accepts valid invite and redirects to /app', async () => {
    const [owner] = await db('users').insert({ google_id: 'gio1', email: 'own@t.com' }).returning('*');
    const [invitee] = await db('users').insert({ google_id: 'gii1', email: 'inv@t.com' }).returning('*');
    const tenant = await createTenantWithMember(owner.id, 'owner');
    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: tenant.id, token, created_by: owner.id,
      expires_at: new Date(Date.now() + 60 * 1000),
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
    const [user] = await db('users').insert({ google_id: 'ge1', email: 'exp@t.com' }).returning('*');
    const tenant = await createTenantWithMember(user.id, 'owner');
    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: tenant.id, token, created_by: user.id,
      expires_at: new Date(Date.now() - 1000),
    });
    const res = await request(app).get(`/join?token=${token}`)
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(400);
  });

  test('returns error page when user already has 9 total workspaces', async () => {
    const [user] = await db('users').insert({ google_id: 'gjlim', email: 'joinlim@t.com' }).returning('*');
    const [owner] = await db('users').insert({ google_id: 'gjo', email: 'jown@t.com' }).returning('*');
    for (let i = 0; i < 9; i++) await createTenantWithMember(user.id, 'member');
    const newTenant = await createTenantWithMember(owner.id, 'owner');
    const token = require('crypto').randomBytes(32).toString('hex');
    await db('invites').insert({
      tenant_id: newTenant.id, token, created_by: owner.id,
      expires_at: new Date(Date.now() + 60 * 1000),
    });
    const res = await request(app).get(`/join?token=${token}`)
      .set('Cookie', [authCookie({ sub: user.id, email: user.email })]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('9 workspaces');
  });
});

// ── POST /workspace/invite ────────────────────────────────────────────────────

describe('POST /workspace/invite', () => {
  test('owner can generate invite link', async () => {
    const [user] = await db('users').insert({ google_id: 'gig1', email: 'ig@t.com' }).returning('*');
    const tenant = await createTenantWithMember(user.id, 'owner');
    const res = await request(app).post('/workspace/invite')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: tenant.id })])
      .send();
    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).toContain('/join?token=');
  });

  test('non-owner gets 403', async () => {
    const [user] = await db('users').insert({ google_id: 'gim1', email: 'im@t.com' }).returning('*');
    const tenant = await createTenantWithMember(user.id, 'member');
    const res = await request(app).post('/workspace/invite')
      .set('Cookie', [authCookie({ sub: user.id, email: user.email, tenantId: tenant.id })])
      .send();
    expect(res.status).toBe(403);
  });
});

// ── DELETE /workspace/members/:userId ─────────────────────────────────────────

describe('DELETE /workspace/members/:userId', () => {
  test('owner revokes member successfully', async () => {
    const [owner] = await db('users').insert({ google_id: 'gro', email: 'ro@t.com' }).returning('*');
    const [member] = await db('users').insert({ google_id: 'grm', email: 'rm@t.com' }).returning('*');
    const tenant = await createTenantWithMember(owner.id, 'owner');
    await insertMember(tenant.id, member.id, 'member');

    const res = await request(app)
      .delete(`/workspace/members/${member.id}`)
      .set('Cookie', [authCookie({ sub: owner.id, email: owner.email, tenantId: tenant.id })]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const check = await db('tenant_members').where({ tenant_id: tenant.id, user_id: member.id }).first();
    expect(check).toBeUndefined();
  });

  test('non-owner gets 403', async () => {
    const [owner] = await db('users').insert({ google_id: 'gno1', email: 'no1@t.com' }).returning('*');
    const [member] = await db('users').insert({ google_id: 'gno2', email: 'no2@t.com' }).returning('*');
    const [target] = await db('users').insert({ google_id: 'gno3', email: 'no3@t.com' }).returning('*');
    const tenant = await createTenantWithMember(owner.id, 'owner');
    await insertMember(tenant.id, member.id, 'member');
    await insertMember(tenant.id, target.id, 'member');

    const res = await request(app)
      .delete(`/workspace/members/${target.id}`)
      .set('Cookie', [authCookie({ sub: member.id, email: member.email, tenantId: tenant.id })]);

    expect(res.status).toBe(403);
  });

  test('cannot self-revoke', async () => {
    const [owner] = await db('users').insert({ google_id: 'gsr1', email: 'sr@t.com' }).returning('*');
    const tenant = await createTenantWithMember(owner.id, 'owner');

    const res = await request(app)
      .delete(`/workspace/members/${owner.id}`)
      .set('Cookie', [authCookie({ sub: owner.id, email: owner.email, tenantId: tenant.id })]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_REVOKE_SELF');
  });

  test('cannot revoke another owner', async () => {
    const [o1] = await db('users').insert({ google_id: 'gco1', email: 'co1@t.com' }).returning('*');
    const [o2] = await db('users').insert({ google_id: 'gco2', email: 'co2@t.com' }).returning('*');
    const tenant = await createTenantWithMember(o1.id, 'owner');
    await insertMember(tenant.id, o2.id, 'owner');

    const res = await request(app)
      .delete(`/workspace/members/${o2.id}`)
      .set('Cookie', [authCookie({ sub: o1.id, email: o1.email, tenantId: tenant.id })]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_REVOKE_OWNER');
  });

  test('returns 404 when member not found', async () => {
    const [owner] = await db('users').insert({ google_id: 'gnf1', email: 'nf@t.com' }).returning('*');
    const tenant = await createTenantWithMember(owner.id, 'owner');
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .delete(`/workspace/members/${fakeId}`)
      .set('Cookie', [authCookie({ sub: owner.id, email: owner.email, tenantId: tenant.id })]);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MEMBER_NOT_FOUND');
  });
});
