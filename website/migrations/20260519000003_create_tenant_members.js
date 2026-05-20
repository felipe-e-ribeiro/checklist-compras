exports.up = async (knex) => {
  await knex.schema.createTable('tenant_members', (t) => {
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('role').notNullable().defaultTo('member');
    t.timestamp('joined_at', { useTz: true }).defaultTo(knex.fn.now());
    t.primary(['tenant_id', 'user_id']);
  });
  await knex.raw('CREATE INDEX ON tenant_members (user_id)');
};

exports.down = (knex) => knex.schema.dropTable('tenant_members');
