exports.up = async (knex) => {
  await knex.raw('ALTER TABLE items ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE items FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_isolation ON items
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  await knex.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE tenant_members FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_member_isolation ON tenant_members
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation ON items');
  await knex.raw('ALTER TABLE items DISABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE items NO FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS tenant_member_isolation ON tenant_members');
  await knex.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE tenant_members NO FORCE ROW LEVEL SECURITY');
};
