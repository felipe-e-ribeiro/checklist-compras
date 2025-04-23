const knex = require('knex');

const db = knex({
    client: process.env.DB_CLIENT || 'mysql2', // 'pg' ou 'mysql2'
    connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    },
});

module.exports = db;