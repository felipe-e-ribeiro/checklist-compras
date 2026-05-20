require('dotenv').config({ path: require('path').join(__dirname, '../../.env.test') });

const { getTestDb, destroyDb } = require('../helpers/dbSetup');

let db;

beforeAll(async () => {
  db = getTestDb();
});

afterAll(async () => {
  await destroyDb();
});

const tables = ['tenants', 'users', 'tenant_members', 'invites', 'refresh_tokens', 'items'];

describe('migrations', () => {
  test.each(tables)('table %s exists', async (table) => {
    const result = await db.raw(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=?`,
      [table]
    );
    expect(result.rows.length).toBe(1);
  });

  test('items has tenant_id column', async () => {
    const result = await db.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_name='items' AND column_name='tenant_id'`
    );
    expect(result.rows.length).toBe(1);
  });

  test('items has uuid primary key', async () => {
    const result = await db.raw(
      `SELECT data_type FROM information_schema.columns WHERE table_name='items' AND column_name='id'`
    );
    expect(result.rows[0].data_type).toBe('uuid');
  });

  test('RLS is enabled on items', async () => {
    const result = await db.raw(
      `SELECT relrowsecurity FROM pg_class WHERE relname='items'`
    );
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  test('RLS is enabled on tenant_members', async () => {
    const result = await db.raw(
      `SELECT relrowsecurity FROM pg_class WHERE relname='tenant_members'`
    );
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  test('tenant_isolation policy exists on items', async () => {
    const result = await db.raw(
      `SELECT 1 FROM pg_policies WHERE tablename='items' AND policyname='tenant_isolation'`
    );
    expect(result.rows.length).toBe(1);
  });

  test('tenant_member_isolation policy exists on tenant_members', async () => {
    const result = await db.raw(
      `SELECT 1 FROM pg_policies WHERE tablename='tenant_members' AND policyname='tenant_member_isolation'`
    );
    expect(result.rows.length).toBe(1);
  });

  test('refresh_tokens has token_hash unique column', async () => {
    const result = await db.raw(
      `SELECT constraint_type FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name='refresh_tokens' AND ccu.column_name='token_hash' AND tc.constraint_type='UNIQUE'`
    );
    expect(result.rows.length).toBe(1);
  });
});
