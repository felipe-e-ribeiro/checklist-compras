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

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await destroyDb();
});

function parseCookies(res) {
  const cookies = {};
  const raw = res.headers['set-cookie'] || [];
  raw.forEach((c) => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    cookies[k.trim()] = v ? v.trim() : '';
  });
  return cookies;
}

describe('POST /auth/logout', () => {
  test('revokes refresh token and clears cookies', async () => {
    const [user] = await db('users').insert({ google_id: 'al1', email: 'logout@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const accessToken = authService.signAccessToken({ sub: user.id, email: user.email });

    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', [`access_token=${accessToken}`, `refresh_token=${refreshToken}`]);

    expect(res.status).toBe(200);
    const cookies = parseCookies(res);
    expect(cookies.access_token).toBe('');
    expect(cookies.refresh_token).toBe('');

    const record = await db('refresh_tokens')
      .where({ user_id: user.id })
      .whereNotNull('revoked_at')
      .first();
    expect(record).toBeDefined();
  });

  test('returns 200 even with no refresh token', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/refresh', () => {
  test('rotates tokens and returns new cookies', async () => {
    const [user] = await db('users').insert({ google_id: 'ar1', email: 'ref@t.com' }).returning('*');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);
    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');

    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`access_token=${expiredToken}`, `refresh_token=${refreshToken}`]);

    expect(res.status).toBe(200);
    const cookies = parseCookies(res);
    expect(cookies.access_token).toBeDefined();
    expect(cookies.refresh_token).toBeDefined();
  });

  test('returns 401 when refresh token is invalid', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', ['access_token=bad', 'refresh_token=bad']);

    expect(res.status).toBe(401);
  });

  test('returns 401 when no cookies present', async () => {
    const res = await request(app).post('/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('GET /auth/google', () => {
  test('redirects to Google OAuth URL', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });
});
