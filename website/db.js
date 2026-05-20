const knex = require('knex');

const env = process.env.NODE_ENV || 'development';
const config = require('./knexfile')[env];

const db = knex({
  ...config,
  pool: { min: 2, max: 50 }, // aumentado de 10 (default) — gargalo identificado em load test
});

module.exports = db;
