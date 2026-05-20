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

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await destroyDb();
});

function mockRes() {
  const res = {
    redirect: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
}

function mockReq(cookieOverrides = {}) {
  return { cookies: { ...cookieOverrides } };
}

describe('requireAuth — access token valid', () => {
  test('injects req.user and calls next()', async () => {
    const token = authService.signAccessToken({ sub: 'user-id', email: 'a@b.com' });
    const req = mockReq({ access_token: token });
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.sub).toBe('user-id');
    expect(req.user.email).toBe('a@b.com');
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('requireAuth — access token missing', () => {
  test('redirects to /auth/google when no refresh token', async () => {
    const req = mockReq({});
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});

describe('requireAuth — access token invalid signature', () => {
  test('redirects to /auth/google', async () => {
    const req = mockReq({ access_token: 'bad.token.here' });
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});

describe('requireAuth — access token expired, refresh token valid', () => {
  test('rotates tokens, sets cookies, injects user, calls next()', async () => {
    const [user] = await db('users')
      .insert({ google_id: 'ga1', email: 'refresh@t.com', name: 'Refresh User' })
      .returning('*');

    const expiredToken = authService.signAccessToken({ sub: user.id, email: user.email }, '-1s');
    const refreshToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, refreshToken, db);

    const cookies = {};
    const res = {
      redirect: jest.fn(),
      cookie: jest.fn((name, val) => { cookies[name] = val; }),
    };
    const req = mockReq({ access_token: expiredToken, refresh_token: refreshToken });
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.sub).toBe(user.id);
    expect(res.cookie).toHaveBeenCalledWith('access_token', expect.any(String), expect.any(Object));
    expect(res.cookie).toHaveBeenCalledWith('refresh_token', expect.any(String), expect.any(Object));
  });
});

describe('requireAuth — access token expired, refresh token invalid', () => {
  test('redirects to /auth/google', async () => {
    const expiredToken = authService.signAccessToken({ sub: 'uid', email: 'x@x.com' }, '-1s');
    const req = mockReq({ access_token: expiredToken, refresh_token: 'invalid-refresh' });
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/auth/google');
  });
});
