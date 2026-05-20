exports.up = (knex) =>
  knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('google_id').notNullable().unique();
    t.text('email').notNullable().unique();
    t.text('name');
    t.text('avatar_url');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

exports.down = (knex) => knex.schema.dropTable('users');
