const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Requeridos via env — sem fallback para evitar branches não testáveis
const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS);

function signAccessToken(payload, expiresIn = ACCESS_TOKEN_EXPIRY) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashRefreshToken(token) {
  return bcrypt.hash(token, BCRYPT_ROUNDS);
}

async function verifyRefreshTokenHash(token, hash) {
  return bcrypt.compare(token, hash);
}

async function saveRefreshToken(userId, token, db) {
  const hash = await hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);
  await db('refresh_tokens').insert({ user_id: userId, token_hash: hash, expires_at: expiresAt });
}

async function validateRefreshToken(token, userId, db) {
  const rows = await db('refresh_tokens')
    .where({ user_id: userId, revoked_at: null })
    .where('expires_at', '>', db.fn.now());

  for (const row of rows) {
    const match = await verifyRefreshTokenHash(token, row.token_hash);
    if (match) return row;
  }
  return null;
}

function decodeWithoutVerify(token) {
  return jwt.decode(token);
}

async function rotateRefreshToken(oldRecord, userId, db) {
  await db('refresh_tokens').where({ id: oldRecord.id }).update({ revoked_at: db.fn.now() });
  const newToken = generateRefreshToken();
  await saveRefreshToken(userId, newToken, db);
  return { newToken };
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  decodeWithoutVerify,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshTokenHash,
  saveRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
};
