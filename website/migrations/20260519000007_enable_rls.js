exports.up = async (knex) => {
  // Items: FORCE RLS — protege dados de compras por tenant
  await knex.raw('ALTER TABLE items ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE items FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_isolation ON items
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  // tenant_members: RLS sem FORCE — o app user (dono da tabela) acessa livremente
  // para listar workspaces do usuário; RLS ativa para usuários não-donos
  await knex.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_member_isolation ON tenant_members
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation ON items');
  await knex.raw('ALTER TABLE items NO FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE items DISABLE ROW LEVEL SECURITY');

  await knex.raw('DROP POLICY IF EXISTS tenant_member_isolation ON tenant_members');
  await knex.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
};
