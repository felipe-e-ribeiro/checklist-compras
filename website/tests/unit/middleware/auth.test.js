require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const authService = require('../../../services/authService');
const { makeRequireAuth } = require('../../../middleware/auth');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;
let requireAuth;

beforeAll(async () => {
  db = getTestDb();
  requireAuth = makeRequireAuth(db);
});
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await destroyDb(); });

function mockRes() {
  return { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), cookie: jest.fn() };
}

describe('valid access token', () => {
  test('injects req.user and calls next()', async () => {
    const token = authService.signAccessToken({ sub: 'user-id', email: 'a@b.com' });
    const req = { cookies: { access_token: token } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.sub).toBe('user-id');
  });
});

describe('no access token', () => {
  test('redirects to /auth/google when no refresh token either', async () => {
    const req = { cookies: {} };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});

describe('invalid token signature', () => {
  test('redirects to /auth/google', async () => {
    const req = { cookies: { access_token: 'bad.token.here' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});

describe('expired token with valid refresh', () => {
  test('rotates tokens, injects user, calls next()', async () => {
    const [user] = await db('users')
      .insert({ google_id: 'ga1', email: 'refresh@t.com', name: 'R' })
      .returning('*');

    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);

    const req = { cookies: { access_token: expiredToken, refresh_token: refreshToken } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.sub).toBe(user.id);
    expect(res.cookie).toHaveBeenCalledWith('access_token', expect.any(String), expect.any(Object));
  });

  test('preserves tenantId from expired token', async () => {
    const [user] = await db('users')
      .insert({ google_id: 'ga2', email: 'tid@t.com' })
      .returning('*');
    const expiredToken = authService.signAccessToken(
      { sub: user.id, email: user.email, tenantId: 'some-tenant' }, '-1s'
    );
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);

    const req = { cookies: { access_token: expiredToken, refresh_token: refreshToken } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.tenantId).toBe('some-tenant');
  });
});

describe('expired token with invalid refresh', () => {
  test('redirects to /auth/google when no tokens exist for user', async () => {
    // UUID válido mas sem tokens no banco → validateRefreshToken retorna null → cobre if(!record)
    const fakeUuid = '00000000-0000-0000-0000-000000000001';
    const expiredToken = authService.signAccessToken({ sub: fakeUuid, email: 'x@x.com' }, '-1s');
    const req = { cookies: { access_token: expiredToken, refresh_token: 'sometoken' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});

describe('expired token + DB error during refresh', () => {
  test('redirects to /auth/google on DB error', async () => {
    const expiredToken = authService.signAccessToken({ sub: 'uid', email: 'x@x.com' }, '-1s');
    // DB that throws on any call
    const brokenDb = Object.assign(
      () => { throw new Error('DB DOWN'); },
      { fn: { now: () => new Date() } }
    );
    const auth = makeRequireAuth(brokenDb);
    const req = { cookies: { access_token: expiredToken, refresh_token: 'any' } };
    const res = mockRes();
    const next = jest.fn();
    await auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});
