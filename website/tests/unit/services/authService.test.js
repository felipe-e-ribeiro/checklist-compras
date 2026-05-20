require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const authService = require('../../../services/authService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;

beforeAll(async () => { db = getTestDb(); });
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await destroyDb(); });

describe('signAccessToken', () => {
  test('returns a JWT string', () => {
    const token = authService.signAccessToken({ sub: 'user-id', email: 'a@b.com' });
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  test('payload readable via verify', () => {
    const payload = { sub: 'user-id', email: 'a@b.com', tenantId: 'tenant-id' };
    const token = authService.signAccessToken(payload);
    const decoded = authService.verifyAccessToken(token);
    expect(decoded.sub).toBe('user-id');
    expect(decoded.tenantId).toBe('tenant-id');
  });
});

describe('verifyAccessToken', () => {
  test('throws for expired token', () => {
    const token = authService.signAccessToken({ sub: 'x' }, '-1s');
    expect(() => authService.verifyAccessToken(token)).toThrow('jwt expired');
  });

  test('throws for invalid token', () => {
    expect(() => authService.verifyAccessToken('bad.token.here')).toThrow();
  });

  test('returns payload for valid token', () => {
    const token = authService.signAccessToken({ sub: 'abc' });
    expect(authService.verifyAccessToken(token).sub).toBe('abc');
  });
});

describe('decodeWithoutVerify', () => {
  test('returns payload without verifying signature', () => {
    const token = authService.signAccessToken({ sub: 'x', email: 'a@b.com' }, '-1s');
    const decoded = authService.decodeWithoutVerify(token);
    expect(decoded.sub).toBe('x');
  });

  test('returns null for malformed token', () => {
    expect(authService.decodeWithoutVerify('not-a-jwt')).toBeNull();
  });
});

describe('generateRefreshToken', () => {
  test('returns a 64-char hex string', () => {
    const token = authService.generateRefreshToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  test('generates unique tokens', () => {
    expect(authService.generateRefreshToken()).not.toBe(authService.generateRefreshToken());
  });
});

describe('hashRefreshToken / verifyRefreshTokenHash', () => {
  test('hash is verifiable', async () => {
    const token = authService.generateRefreshToken();
    const hash = await authService.hashRefreshToken(token);
    expect(await authService.verifyRefreshTokenHash(token, hash)).toBe(true);
  });

  test('wrong token does not match hash', async () => {
    const token = authService.generateRefreshToken();
    const hash = await authService.hashRefreshToken(token);
    expect(await authService.verifyRefreshTokenHash('wrong', hash)).toBe(false);
  });
});

describe('saveRefreshToken', () => {
  test('inserts a record in refresh_tokens', async () => {
    const [user] = await db('users').insert({ google_id: 'g1', email: 't@t.com' }).returning('*');
    const token = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, token, db);
    const rows = await db('refresh_tokens').where({ user_id: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).toBeNull();
  });
});

describe('validateRefreshToken', () => {
  test('returns record for valid token', async () => {
    const [user] = await db('users').insert({ google_id: 'g2', email: 'v@t.com' }).returning('*');
    const token = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, token, db);
    const record = await authService.validateRefreshToken(token, user.id, db);
    expect(record).not.toBeNull();
  });

  test('returns null when hash does not match (different token)', async () => {
    const [user] = await db('users').insert({ google_id: 'g-mm', email: 'mm@t.com' }).returning('*');
    const token1 = authService.generateRefreshToken();
    const token2 = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, token1, db);
    // token2 != token1 → hash won't match → covers if(match) false branch
    const record = await authService.validateRefreshToken(token2, user.id, db);
    expect(record).toBeNull();
  });

  test('returns null for revoked token', async () => {
    const [user] = await db('users').insert({ google_id: 'g3', email: 'r@t.com' }).returning('*');
    const token = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, token, db);
    await db('refresh_tokens').where({ user_id: user.id }).update({ revoked_at: db.fn.now() });
    expect(await authService.validateRefreshToken(token, user.id, db)).toBeNull();
  });

  test('returns null for expired token', async () => {
    const [user] = await db('users').insert({ google_id: 'g4', email: 'e@t.com' }).returning('*');
    const token = authService.generateRefreshToken();
    const hash = await authService.hashRefreshToken(token);
    await db('refresh_tokens').insert({ user_id: user.id, token_hash: hash, expires_at: new Date(Date.now() - 1000) });
    expect(await authService.validateRefreshToken(token, user.id, db)).toBeNull();
  });

  test('returns null for wrong user', async () => {
    const [u1] = await db('users').insert({ google_id: 'g5', email: 'u1@t.com' }).returning('*');
    const [u2] = await db('users').insert({ google_id: 'g6', email: 'u2@t.com' }).returning('*');
    const token = authService.generateRefreshToken();
    await authService.saveRefreshToken(u1.id, token, db);
    expect(await authService.validateRefreshToken(token, u2.id, db)).toBeNull();
  });

  test('returns null for nonexistent token', async () => {
    const [user] = await db('users').insert({ google_id: 'g7', email: 'n@t.com' }).returning('*');
    expect(await authService.validateRefreshToken('nonexistent', user.id, db)).toBeNull();
  });
});

describe('rotateRefreshToken', () => {
  test('revokes old token and returns new one', async () => {
    const [user] = await db('users').insert({ google_id: 'g8', email: 'rot@t.com' }).returning('*');
    const oldToken = authService.generateRefreshToken();
    await authService.saveRefreshToken(user.id, oldToken, db);
    const oldRecord = await db('refresh_tokens').where({ user_id: user.id }).first();

    const { newToken } = await authService.rotateRefreshToken(oldRecord, user.id, db);
    expect(typeof newToken).toBe('string');
    expect(newToken).not.toBe(oldToken);

    const revoked = await db('refresh_tokens').where({ id: oldRecord.id }).first();
    expect(revoked.revoked_at).not.toBeNull();

    const active = await db('refresh_tokens').where({ user_id: user.id, revoked_at: null });
    expect(active).toHaveLength(1);
  });
});
