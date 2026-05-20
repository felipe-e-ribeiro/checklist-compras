require('dotenv').config({ path: require('path').join(__dirname, '../../.env.test') });

const knex = require('knex');

module.exports = async () => {
  const db = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER || 'test',
      password: process.env.DB_PASSWORD || 'test',
      database: process.env.DB_NAME || 'lista_compras_test',
    },
    pool: { min: 0, max: 2 },
    migrations: { directory: require('path').join(__dirname, '../../migrations') },
  });

  // Matar conexões presas de runs anteriores
  await db.raw(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'idle in transaction'
      AND pid != pg_backend_pid()
  `);

  try { await db.migrate.forceFreeMigrationsLock(); } catch { /* ok */ }

  // Não faz rollback completo — apenas garante que o schema está na última versão
  await db.migrate.latest();

  // Limpar dados de runs anteriores
  await db.raw(
    'TRUNCATE TABLE items, invites, refresh_tokens, tenant_members, users, tenants RESTART IDENTITY CASCADE'
  );

  await db.destroy();
};
