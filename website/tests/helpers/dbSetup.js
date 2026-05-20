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
      pool: { min: 0, max: 5 },
      migrations: { directory: require('path').join(__dirname, '../../migrations') },
    });
  }
  return db;
}

async function unlock() {
  const db = getTestDb();
  try { await db.migrate.forceFreeMigrationsLock(); } catch { /* ok */ }
}

async function migrate() {
  await unlock();
  await getTestDb().migrate.latest();
}

async function rollback() {
  await unlock();
  await getTestDb().migrate.rollback(undefined, true);
}

async function truncateAll() {
  const db = getTestDb();
  // Matar conexões idle-in-transaction que bloqueiam DDL/TRUNCATE
  await db.raw(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'idle in transaction'
      AND pid != pg_backend_pid()
  `);
  await db.raw(
    'TRUNCATE TABLE items, invites, refresh_tokens, tenant_members, users, tenants RESTART IDENTITY CASCADE'
  );
}

async function destroyDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

module.exports = { getTestDb, migrate, rollback, truncateAll, destroyDb };
