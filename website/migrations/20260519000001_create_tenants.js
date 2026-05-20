exports.up = (knex) =>
  knex.schema.createTable('tenants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.text('slug').notNullable().unique();
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

exports.down = (knex) => knex.schema.dropTable('tenants');
