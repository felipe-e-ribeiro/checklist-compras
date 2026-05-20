exports.up = (knex) =>
  knex.schema.createTable('invites', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('token').notNullable().unique();
    t.uuid('created_by').references('id').inTable('users');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
  });

exports.down = (knex) => knex.schema.dropTable('invites');
