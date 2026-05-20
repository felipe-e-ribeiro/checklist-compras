require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const request = require('supertest');
const { createApp } = require('../../../server');
const authService = require('../../../services/authService');
const makeAuthRouter = require('../../../routes/auth');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let app, db;

beforeAll(async () => {
  db = getTestDb();
  app = createApp(db);
});
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await destroyDb(); });

function parseCookies(res) {
  const cookies = {};
  (res.headers['set-cookie'] || []).forEach((c) => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    cookies[k.trim()] = v ? v.trim() : '';
  });
  return cookies;
}

// ── GET /login ───────────────────────────────────────────────────────────────

describe('GET /login', () => {
  test('renders login page', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Entrar com Google');
  });
});

// ── OAuth callback (tested directly to bypass passport) ──────────────────────

describe('_handleOAuthCallback', () => {
  test('sets tokens in cookies and redirects to /select-workspace', async () => {
    const [user] = await db('users')
      .insert({ google_id: 'oauth1', email: 'oauth@test.com' })
      .returning('*');

    const cookies = {};
    const req = { user };
    const res = {
      cookie: jest.fn((k, v) => { cookies[k] = v; }),
      redirect: jest.fn(),
    };

    await makeAuthRouter._handleOAuthCallback(req, res, db);

    expect(res.redirect).toHaveBeenCalledWith('/select-workspace');
    expect(cookies.access_token).toBeDefined();
    expect(cookies.refresh_token).toBeDefined();

    const tokenRecord = await db('refresh_tokens').where({ user_id: user.id }).first();
    expect(tokenRecord).toBeDefined();
  });
});

// ── POST /auth/logout ────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  test('revokes refresh token, clears cookies, redirects to /login', async () => {
    const [user] = await db('users').insert({ google_id: 'al1', email: 'logout@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const accessToken = authService.signAccessToken({ sub: user.id, email: user.email });

    const res = await request(app).post('/auth/logout')
      .set('Cookie', [`access_token=${accessToken}`, `refresh_token=${refreshToken}`]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    const cookies = parseCookies(res);
    expect(cookies.access_token).toBe('');
    expect(cookies.refresh_token).toBe('');

    const revoked = await db('refresh_tokens').where({ user_id: user.id }).whereNotNull('revoked_at').first();
    expect(revoked).toBeDefined();
  });

  test('redirects to /login even with no cookies', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('redirects to /login with expired access token (covers catch branch)', async () => {
    const [user] = await db('users').insert({ google_id: 'al2', email: 'logexp@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');

    const res = await request(app).post('/auth/logout')
      .set('Cookie', [`access_token=${expiredToken}`, `refresh_token=${refreshToken}`]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('redirects to /login when refresh record not found', async () => {
    const [user] = await db('users').insert({ google_id: 'al3', email: 'lognoref@t.com' }).returning('*');
    const accessToken = authService.signAccessToken({ sub: user.id, email: user.email });

    const res = await request(app).post('/auth/logout')
      .set('Cookie', [`access_token=${accessToken}`, `refresh_token=nonexistent`]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

// ── POST /auth/refresh ───────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  test('rotates tokens with expired access token', async () => {
    const [user] = await db('users').insert({ google_id: 'ar1', email: 'ref@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');

    const res = await request(app).post('/auth/refresh')
      .set('Cookie', [`access_token=${expiredToken}`, `refresh_token=${refreshToken}`]);

    expect(res.status).toBe(200);
    const cookies = parseCookies(res);
    expect(cookies.access_token).toBeDefined();
    expect(cookies.refresh_token).toBeDefined();
  });

  test('includes tenantId in new token when present in old token', async () => {
    const [user] = await db('users').insert({ google_id: 'ar-tid', email: 'reftid@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const expiredToken = authService.signAccessToken(
      { sub: user.id, email: user.email, tenantId: 'some-tenant' }, '-1s'
    );

    const res = await request(app).post('/auth/refresh')
      .set('Cookie', [`access_token=${expiredToken}`, `refresh_token=${refreshToken}`]);

    expect(res.status).toBe(200);
    const newToken = parseCookies(res).access_token;
    const decoded = authService.decodeWithoutVerify(newToken);
    expect(decoded.tenantId).toBe('some-tenant');
  });

  test('returns 401 with no refresh token', async () => {
    const res = await request(app).post('/auth/refresh');
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid refresh token', async () => {
    const res = await request(app).post('/auth/refresh')
      .set('Cookie', ['access_token=bad', 'refresh_token=bad']);
    expect(res.status).toBe(401);
  });

  test('returns 401 when no access token provided (decoded is null)', async () => {
    const res = await request(app).post('/auth/refresh')
      .set('Cookie', ['refresh_token=sometoken']);
    expect(res.status).toBe(401);
  });

  test('returns 401 when refresh token not found in DB', async () => {
    const [user] = await db('users').insert({ google_id: 'ar2', email: 'noref@t.com' }).returning('*');
    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');

    const res = await request(app).post('/auth/refresh')
      .set('Cookie', [`access_token=${expiredToken}`, `refresh_token=notexist`]);
    expect(res.status).toBe(401);
  });
});

// ── GET /auth/google ─────────────────────────────────────────────────────────

describe('GET /auth/google', () => {
  test('redirects to Google OAuth URL', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });
});
