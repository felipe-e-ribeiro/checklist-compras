require('dotenv').config({ path: require('path').join(__dirname, '../../.env.test') });

const knex = require('knex');

let db;

function getTestDb() {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER || 'test',
        password: process.env.DB_PASSWORD || 'test',
        database: process.env.DB_NAME || 'lista_compras_test',
      },
      migrations: { directory: require('path').join(__dirname, '../../migrations') },
    });
  }
  return db;
}

async function unlock() {
  const db = getTestDb();
  try { await db.migrate.forceFreeMigrationsLock(); } catch { /* already unlocked */ }
}

async function migrate() {
  const db = getTestDb();
  await unlock();
  await db.migrate.latest();
}

async function rollback() {
  const db = getTestDb();
  await unlock();
  await db.migrate.rollback(undefined, true);
}

async function truncateAll() {
  const db = getTestDb();
  // Disable RLS temporarily for truncation
  await db.raw('ALTER TABLE items DISABLE ROW LEVEL SECURITY');
  await db.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
  await db.raw(
    'TRUNCATE TABLE items, invites, refresh_tokens, tenant_members, users, tenants RESTART IDENTITY CASCADE'
  );
  await db.raw('ALTER TABLE items ENABLE ROW LEVEL SECURITY');
  await db.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');
}

async function destroyDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

module.exports = { getTestDb, migrate, rollback, truncateAll, destroyDb };
