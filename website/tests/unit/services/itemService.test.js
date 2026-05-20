require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const itemService = require('../../../services/itemService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let db;
let tenantA, tenantB;

beforeAll(async () => { db = getTestDb(); });

beforeEach(async () => {
  await truncateAll();
  [tenantA] = await db('tenants').insert({ name: 'A', slug: 'item-a' }).returning('*');
  [tenantB] = await db('tenants').insert({ name: 'B', slug: 'item-b' }).returning('*');
});

afterAll(async () => { await destroyDb(); });

// Helper: lê items diretamente dentro de uma transação com set_config
async function readItems(tenantId, where = {}) {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);
    return trx('items').where({ tenant_id: tenantId, ...where });
  });
}

describe('addItem', () => {
  test('adds item to correct tenant', async () => {
    const item = await itemService.addItem(tenantA.id, 'Arroz', db);
    expect(item.item).toBe('Arroz');
    expect(item.tenant_id).toBe(tenantA.id);
    expect(item.checked).toBe(false);
  });
});

describe('listItems', () => {
  test('returns only non-archived items of tenant', async () => {
    await itemService.addItem(tenantA.id, 'Feijão', db);
    const [toArchive] = await db('items').insert({ tenant_id: tenantA.id, item: 'Archived', archived: true }).returning('*');
    await itemService.addItem(tenantB.id, 'Outro', db);

    const items = await itemService.listItems(tenantA.id, 'item', db);
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe('Feijão');
  });

  test('sorts by checked when sortBy=checked', async () => {
    await itemService.addItem(tenantA.id, 'Z', db);
    await itemService.addItem(tenantA.id, 'A', db);
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ tenant_id: tenantA.id, item: 'Z' }).update({ checked: true });
    });

    const items = await itemService.listItems(tenantA.id, 'checked', db);
    expect(items[0].item).toBe('A');
    expect(items[1].item).toBe('Z');
  });
});

describe('checkItem', () => {
  test('updates checked status', async () => {
    const item = await itemService.addItem(tenantA.id, 'Leite', db);
    await itemService.checkItem(tenantA.id, item.id, true, db);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].checked).toBe(true);
  });
});

describe('archiveChecked', () => {
  test('archives only checked items of the tenant', async () => {
    await itemService.addItem(tenantA.id, 'Checked', db);
    await itemService.addItem(tenantA.id, 'Unchecked', db);
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ tenant_id: tenantA.id, item: 'Checked' }).update({ checked: true });
    });

    const count = await itemService.archiveChecked(tenantA.id, db);
    expect(count).toBe(1);

    const archived = await readItems(tenantA.id, { archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].item).toBe('Checked');
  });
});

describe('listArchived', () => {
  test('returns only archived items of tenant', async () => {
    await itemService.addItem(tenantA.id, 'ToArchive', db);
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ tenant_id: tenantA.id }).update({ archived: true, archived_at: trx.fn.now() });
    });

    const archived = await itemService.listArchived(tenantA.id, db);
    expect(archived).toHaveLength(1);
    expect(archived[0].item).toBe('ToArchive');
  });
});

describe('updateItem', () => {
  test('updates quantity to a value', async () => {
    const item = await itemService.addItem(tenantA.id, 'Arroz', db);
    await itemService.updateItem(tenantA.id, item.id, { quantity: '2kg' }, db);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].quantity).toBe('2kg');
  });

  test('clears quantity when set to empty string', async () => {
    const item = await itemService.addItem(tenantA.id, 'Feijão', db);
    await itemService.updateItem(tenantA.id, item.id, { quantity: null }, db);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].quantity).toBeNull();
  });

  test('updates is_critical to true', async () => {
    const item = await itemService.addItem(tenantA.id, 'Leite', db);
    await itemService.updateItem(tenantA.id, item.id, { is_critical: true }, db);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].is_critical).toBe(true);
  });
});

describe('deleteArchived', () => {
  test('deletes archived items of tenant only', async () => {
    await itemService.addItem(tenantA.id, 'Del', db);
    await itemService.addItem(tenantB.id, 'Keep', db);
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ tenant_id: tenantA.id }).update({ archived: true });
    });

    await itemService.deleteArchived(tenantA.id, db);

    const remaining = await readItems(tenantA.id);
    expect(remaining).toHaveLength(0);
    // tenantB intocado
    const rowsB = await db('items').where({ tenant_id: tenantB.id });
    expect(rowsB).toHaveLength(1);
  });
});
