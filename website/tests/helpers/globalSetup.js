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
    migrations: { directory: require('path').join(__dirname, '../../migrations') },
  });

  try { await db.migrate.forceFreeMigrationsLock(); } catch { /* already unlocked */ }
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();

  await db.destroy();
};
