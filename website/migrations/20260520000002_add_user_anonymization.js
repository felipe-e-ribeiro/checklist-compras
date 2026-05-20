exports.up = (knex) =>
  knex.schema.table('users', (t) => {
    t.timestamp('anonymized_at', { useTz: true }).nullable();
  });

exports.down = (knex) =>
  knex.schema.table('users', (t) => {
    t.dropColumn('anonymized_at');
  });
