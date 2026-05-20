require('dotenv').config({ path: require('path').join(__dirname, '../../../.env.test') });

const request = require('supertest');
const { createApp } = require('../../../server');
const authService = require('../../../services/authService');
const { getTestDb, truncateAll, destroyDb } = require('../../helpers/dbSetup');

let app, db;
let tenantA, tenantB, userA, userB;

beforeAll(async () => {
  db = getTestDb();
  app = createApp(db);
});

beforeEach(async () => {
  await truncateAll();
  [tenantA] = await db('tenants').insert({ name: 'TA', slug: 'ir-ta' }).returning('*');
  [tenantB] = await db('tenants').insert({ name: 'TB', slug: 'ir-tb' }).returning('*');
  [userA] = await db('users').insert({ google_id: 'gir1', email: 'ira@t.com' }).returning('*');
  [userB] = await db('users').insert({ google_id: 'gir2', email: 'irb@t.com' }).returning('*');
  await db('tenant_members').insert([
    { tenant_id: tenantA.id, user_id: userA.id, role: 'owner' },
    { tenant_id: tenantB.id, user_id: userB.id, role: 'owner' },
  ]);
});

afterAll(async () => { await destroyDb(); });

function cookieA() {
  return `access_token=${authService.signAccessToken({ sub: userA.id, email: userA.email, tenantId: tenantA.id })}`;
}
function cookieB() {
  return `access_token=${authService.signAccessToken({ sub: userB.id, email: userB.email, tenantId: tenantB.id })}`;
}

// Insere item sem passar pelo HTTP (usa mini-trx para RLS)
async function insertItem(tenantId, itemText) {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);
    const [item] = await trx('items').insert({ tenant_id: tenantId, item: itemText }).returning('*');
    return item;
  });
}

// Lê items diretamente com mini-trx
async function readItems(tenantId, where = {}) {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);
    return trx('items').where({ tenant_id: tenantId, ...where });
  });
}

describe('GET /app — unauthenticated', () => {
  test('redirects to /auth/google', async () => {
    const res = await request(app).get('/app');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('GET /app — no tenantId in token', () => {
  test('returns 403', async () => {
    const token = authService.signAccessToken({ sub: userA.id, email: userA.email });
    const res = await request(app).get('/app')
      .set('Cookie', [`access_token=${token}`]);
    expect(res.status).toBe(403);
  });
});

describe('GET /app — valid tenant', () => {
  test('renders items from correct tenant only', async () => {
    await insertItem(tenantA.id, 'Item A');
    await insertItem(tenantB.id, 'Item B');

    const res = await request(app).get('/app').set('Cookie', [cookieA()]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Item A');
    expect(res.text).not.toContain('Item B');
  });
});

describe('POST /app/add', () => {
  test('adds item to correct tenant (HTML redirect)', async () => {
    const res = await request(app).post('/app/add')
      .set('Cookie', [cookieA()])
      .send('item=Feij%C3%A3o');
    expect(res.status).toBe(302);

    const items = await readItems(tenantA.id);
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe('Feijão');
  });

  test('adds item and returns JSON when Accept: application/json', async () => {
    const res = await request(app).post('/app/add')
      .set('Cookie', [cookieA()])
      .set('Accept', 'application/json')
      .send({ item: 'Arroz' });
    expect(res.status).toBe(201);
    expect(res.body.item).toBe('Arroz');
  });

  test('returns 400 if item is empty', async () => {
    const res = await request(app).post('/app/add')
      .set('Cookie', [cookieA()]).send('item=');
    expect(res.status).toBe(400);
  });
});

describe('POST /app/check', () => {
  test('marks item as checked (HTML redirect)', async () => {
    const item = await insertItem(tenantA.id, 'Leite');
    await request(app).post('/app/check')
      .set('Cookie', [cookieA()])
      .send(`id=${item.id}&checked=on`);

    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].checked).toBe(true);
  });

  test('marks item and returns JSON when Accept: application/json', async () => {
    const item = await insertItem(tenantA.id, 'Queijo');
    const res = await request(app).post('/app/check')
      .set('Cookie', [cookieA()])
      .set('Accept', 'application/json')
      .send({ id: item.id, checked: 'on' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('tenant B cannot affect tenant A items', async () => {
    const item = await insertItem(tenantA.id, 'Protected');
    await request(app).post('/app/check')
      .set('Cookie', [cookieB()])
      .send(`id=${item.id}&checked=on`);

    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].checked).toBe(false);
  });
});

describe('POST /app/clear-checked', () => {
  test('archives checked items of tenant (HTML redirect)', async () => {
    const item = await insertItem(tenantA.id, 'ToArchive');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: item.id }).update({ checked: true });
    });

    const res = await request(app).post('/app/clear-checked').set('Cookie', [cookieA()]);
    expect(res.status).toBe(302);

    const archived = await readItems(tenantA.id, { archived: true });
    expect(archived).toHaveLength(1);
  });

  test('archives checked items and returns JSON when Accept: application/json', async () => {
    const item = await insertItem(tenantA.id, 'ToArchiveJSON');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: item.id }).update({ checked: true });
    });

    const res = await request(app).post('/app/clear-checked')
      .set('Cookie', [cookieA()])
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('calls webhook with validateStatus and handles success', async () => {
    const axios = require('axios');
    const item = await insertItem(tenantA.id, 'WebhookItem');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: item.id }).update({ checked: true });
    });

    // Mock axios para exercitar validateStatus
    const spy = jest.spyOn(axios, 'get').mockImplementationOnce((_url, opts) => {
      // Chama validateStatus como axios faria com status 200
      opts.validateStatus(200);
      opts.validateStatus(500);
      return Promise.resolve({ status: 200 });
    });

    process.env.FQDN_URL = 'http://fake-webhook.local';
    const res = await request(app).post('/app/clear-checked').set('Cookie', [cookieA()]);
    delete process.env.FQDN_URL;
    spy.mockRestore();

    expect(res.status).toBe(302);
  });

  test('handles webhook network error (non-fatal)', async () => {
    const axios = require('axios');
    const item = await insertItem(tenantA.id, 'WebhookFail');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: item.id }).update({ checked: true });
    });

    const spy = jest.spyOn(axios, 'get').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    process.env.FQDN_URL = 'http://fake-webhook.local';
    const res = await request(app).post('/app/clear-checked').set('Cookie', [cookieA()]);
    delete process.env.FQDN_URL;
    spy.mockRestore();

    expect(res.status).toBe(302); // non-fatal
  });
});

describe('PATCH /app/item/:id', () => {
  test('updates quantity with a value', async () => {
    const item = await insertItem(tenantA.id, 'Arroz');
    const res = await request(app)
      .patch(`/app/item/${item.id}`)
      .set('Cookie', [cookieA()])
      .send({ quantity: '2kg' });
    expect(res.status).toBe(200);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].quantity).toBe('2kg');
  });

  test('clears quantity when sent as empty string', async () => {
    const item = await insertItem(tenantA.id, 'Feijão');
    await request(app)
      .patch(`/app/item/${item.id}`)
      .set('Cookie', [cookieA()])
      .send({ quantity: '' });
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].quantity).toBeNull();
  });

  test('updates is_critical to true', async () => {
    const item = await insertItem(tenantA.id, 'Leite');
    const res = await request(app)
      .patch(`/app/item/${item.id}`)
      .set('Cookie', [cookieA()])
      .send({ is_critical: true });
    expect(res.status).toBe(200);
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].is_critical).toBe(true);
  });

  test('returns 400 when no updates provided', async () => {
    const item = await insertItem(tenantA.id, 'Sal');
    const res = await request(app)
      .patch(`/app/item/${item.id}`)
      .set('Cookie', [cookieA()])
      .send({});
    expect(res.status).toBe(400);
  });

  test('tenant B cannot update tenant A items (isolation)', async () => {
    const item = await insertItem(tenantA.id, 'Protected');
    await request(app)
      .patch(`/app/item/${item.id}`)
      .set('Cookie', [cookieB()])
      .send({ quantity: 'hacked' });
    const rows = await readItems(tenantA.id, { id: item.id });
    expect(rows[0].quantity).toBeNull();
  });
});

describe('POST /app/check-archived', () => {
  test('returns archived items of tenant only', async () => {
    const itemA = await insertItem(tenantA.id, 'Arch A');
    const itemB = await insertItem(tenantB.id, 'Arch B');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: itemA.id }).update({ archived: true, archived_at: trx.fn.now() });
    });
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantB.id]);
      await trx('items').where({ id: itemB.id }).update({ archived: true, archived_at: trx.fn.now() });
    });

    const res = await request(app).post('/app/check-archived').set('Cookie', [cookieA()]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].item).toBe('Arch A');
  });
});

describe('DELETE /app/remove-archived', () => {
  test('removes only archived items of tenant', async () => {
    const itemA = await insertItem(tenantA.id, 'ToDelete A');
    const itemB = await insertItem(tenantB.id, 'Keep B');
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantA.id]);
      await trx('items').where({ id: itemA.id }).update({ archived: true });
    });
    await db.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantB.id]);
      await trx('items').where({ id: itemB.id }).update({ archived: true });
    });

    const res = await request(app).delete('/app/remove-archived').set('Cookie', [cookieA()]);
    expect(res.status).toBe(200);

    // tenantB intocado
    const remainB = await readItems(tenantB.id, { archived: true });
    expect(remainB).toHaveLength(1);
  });
});
