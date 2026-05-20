require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const itemService = require('../../../services/itemService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;
let tenantA, tenantB, userA;

beforeAll(async () => {
  db = getTestDb();
});

beforeEach(async () => {
  await truncateAll();
  [tenantA] = await db('tenants').insert({ name: 'A', slug: 'item-a' }).returning('*');
  [tenantB] = await db('tenants').insert({ name: 'B', slug: 'item-b' }).returning('*');
  [userA] = await db('users').insert({ google_id: 'gi-is1', email: 'is@t.com' }).returning('*');
});

afterAll(async () => {
  await destroyDb();
});

async function withTenant(tenantId, fn) {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);
    return fn(trx);
  });
}

describe('addItem', () => {
  test('adds item to correct tenant', async () => {
    const item = await withTenant(tenantA.id, (trx) =>
      itemService.addItem(tenantA.id, 'Arroz', trx)
    );
    expect(item.item).toBe('Arroz');
    expect(item.tenant_id).toBe(tenantA.id);
    expect(item.checked).toBe(false);
  });
});

describe('listItems', () => {
  test('returns only non-archived items of tenant', async () => {
    await withTenant(tenantA.id, async (trx) => {
      await itemService.addItem(tenantA.id, 'Feijão', trx);
      await itemService.addItem(tenantA.id, 'Archived', trx);
    });
    await withTenant(tenantB.id, async (trx) => {
      await itemService.addItem(tenantB.id, 'Outro', trx);
    });

    await db('items').where({ item: 'Archived' }).update({ archived: true });

    const items = await withTenant(tenantA.id, (trx) =>
      itemService.listItems(tenantA.id, 'item', trx)
    );
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe('Feijão');
  });

  test('sorts by checked when sortBy=checked', async () => {
    await withTenant(tenantA.id, async (trx) => {
      await itemService.addItem(tenantA.id, 'Z', trx);
      await itemService.addItem(tenantA.id, 'A', trx);
    });
    await db('items').where({ item: 'Z' }).update({ checked: true });

    const items = await withTenant(tenantA.id, (trx) =>
      itemService.listItems(tenantA.id, 'checked', trx)
    );
    expect(items[0].item).toBe('A');
    expect(items[1].item).toBe('Z');
  });
});

describe('checkItem', () => {
  test('updates checked status of item in tenant', async () => {
    const item = await withTenant(tenantA.id, (trx) =>
      itemService.addItem(tenantA.id, 'Leite', trx)
    );
    await withTenant(tenantA.id, (trx) =>
      itemService.checkItem(tenantA.id, item.id, true, trx)
    );
    const updated = await db('items').where({ id: item.id }).first();
    expect(updated.checked).toBe(true);
  });
});

describe('archiveChecked', () => {
  test('archives only checked items of the tenant', async () => {
    await withTenant(tenantA.id, async (trx) => {
      await itemService.addItem(tenantA.id, 'Checked', trx);
      await itemService.addItem(tenantA.id, 'Unchecked', trx);
    });
    await db('items').where({ item: 'Checked' }).update({ checked: true });

    const count = await withTenant(tenantA.id, (trx) =>
      itemService.archiveChecked(tenantA.id, trx)
    );
    expect(count).toBe(1);

    const archived = await db('items').where({ archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].item).toBe('Checked');
  });
});

describe('listArchived', () => {
  test('returns only archived items of tenant', async () => {
    await withTenant(tenantA.id, async (trx) => {
      await itemService.addItem(tenantA.id, 'ToArchive', trx);
    });
    await db('items').where({ item: 'ToArchive' }).update({ archived: true, archived_at: db.fn.now() });

    const archived = await withTenant(tenantA.id, (trx) =>
      itemService.listArchived(tenantA.id, trx)
    );
    expect(archived).toHaveLength(1);
    expect(archived[0].item).toBe('ToArchive');
  });
});

describe('deleteArchived', () => {
  test('deletes archived items of tenant only', async () => {
    await withTenant(tenantA.id, async (trx) => {
      await itemService.addItem(tenantA.id, 'Del', trx);
    });
    await db('items').where({ item: 'Del' }).update({ archived: true });

    await withTenant(tenantA.id, (trx) =>
      itemService.deleteArchived(tenantA.id, trx)
    );

    const remaining = await db('items').where({ tenant_id: tenantA.id });
    expect(remaining).toHaveLength(0);
  });
});
