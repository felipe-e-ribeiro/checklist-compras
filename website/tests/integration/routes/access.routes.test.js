require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const request = require('supertest');
const { createApp } = require('../../../server');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let app, db;

beforeAll(async () => {
  db = getTestDb();
  app = createApp(db);
});
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await destroyDb(); });

// helper para controlar a flag durante os testes
function withAuthEnabled(value, fn) {
  const saved = process.env.LOCAL_AUTH_ENABLED;
  process.env.LOCAL_AUTH_ENABLED = value;
  return fn().finally(() => { process.env.LOCAL_AUTH_ENABLED = saved; });
}

// ── GET /access ───────────────────────────────────────────────────────

describe('GET /access — disabled', () => {
  test('returns 404 when LOCAL_AUTH_ENABLED is not true', () =>
    withAuthEnabled('false', async () => {
      const res = await request(app).get('/access');
      expect(res.status).toBe(404);
    }));
});

describe('GET /access — enabled', () => {
  test('renders login form', async () => {
    const res = await request(app).get('/access');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Acesso — Lista de Compras');
  });
});

// ── POST /access ──────────────────────────────────────────────────────

describe('POST /access — disabled', () => {
  test('returns 404 when LOCAL_AUTH_ENABLED is not true', () =>
    withAuthEnabled('false', async () => {
      const res = await request(app).post('/access').send({ username: 'x', password: 'y' });
      expect(res.status).toBe(404);
    }));
});

describe('POST /access — invalid credentials', () => {
  test('re-renders form with error message', async () => {
    const res = await request(app).post('/access')
      .send({ username: 'wrong', password: 'wrong' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Credenciais inválidas');
  });
});

describe('POST /access — valid credentials, first login', () => {
  test('creates user + workspace, sets cookies, redirects to /app', async () => {
    const res = await request(app).post('/access')
      .send({ username: 'loadtest', password: 'loadtest123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);

    const user = await db('users').where({ google_id: 'local:loadtest' }).first();
    expect(user).toBeDefined();
    expect(user.email).toBe('loadtest@local.test');

    const membership = await db('tenant_members').where({ user_id: user.id }).first();
    expect(membership).toBeDefined();
    expect(membership.role).toBe('owner');
  });
});

describe('POST /access — valid credentials, user exists with workspace', () => {
  test('reuses existing user and workspace, redirects to /app', async () => {
    // Primeiro login — cria tudo
    await request(app).post('/access').send({ username: 'loadtest', password: 'loadtest123' });

    // Segundo login — deve reutilizar
    const res = await request(app).post('/access')
      .send({ username: 'loadtest', password: 'loadtest123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    // Só deve existir um usuário e um workspace
    const users = await db('users').where({ google_id: 'local:loadtest' });
    expect(users).toHaveLength(1);

    const memberships = await db('tenant_members').where({ user_id: users[0].id });
    expect(memberships).toHaveLength(1);
  });
});

describe('POST /access — valid credentials, user exists without workspace', () => {
  test('creates workspace for existing user', async () => {
    // Inserir usuário direto sem workspace
    const [user] = await db('users')
      .insert({ google_id: 'local:loadtest', email: 'loadtest@local.test', name: 'loadtest' })
      .returning('*');

    const res = await request(app).post('/access')
      .send({ username: 'loadtest', password: 'loadtest123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    const membership = await db('tenant_members').where({ user_id: user.id }).first();
    expect(membership).toBeDefined();
  });
});
