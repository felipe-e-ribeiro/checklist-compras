exports.up = async (knex) => {
  await knex.schema.createTable('items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('item').notNullable();
    t.boolean('checked').notNullable().defaultTo(false);
    t.boolean('archived').notNullable().defaultTo(false);
    t.timestamp('archived_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX ON items (tenant_id, archived)');
};

exports.down = (knex) => knex.schema.dropTable('items');
