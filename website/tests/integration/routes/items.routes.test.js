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

  await db.raw('ALTER TABLE tenant_members DISABLE ROW LEVEL SECURITY');
  await db('tenant_members').insert([
    { tenant_id: tenantA.id, user_id: userA.id, role: 'owner' },
    { tenant_id: tenantB.id, user_id: userB.id, role: 'owner' },
  ]);
  await db.raw('ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY');
});

afterAll(async () => {
  await destroyDb();
});

function authCookie(userId, email, tenantId) {
  const token = authService.signAccessToken({ sub: userId, email, tenantId });
  return `access_token=${token}`;
}

function cookieA() {
  return authCookie(userA.id, userA.email, tenantA.id);
}

function cookieB() {
  return authCookie(userB.id, userB.email, tenantB.id);
}

async function insertItemDirect(tenantId, itemText) {
  await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantId]);
  const [item] = await db('items').insert({ tenant_id: tenantId, item: itemText }).returning('*');
  return item;
}

describe('GET /app — unauthenticated', () => {
  test('redirects to /auth/google', async () => {
    const res = await request(app).get('/app');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/google');
  });
});

describe('GET /app — no tenantId', () => {
  test('returns 403', async () => {
    const token = authService.signAccessToken({ sub: userA.id, email: userA.email });
    const res = await request(app)
      .get('/app')
      .set('Cookie', [`access_token=${token}`]);
    expect(res.status).toBe(403);
  });
});

describe('GET /app — valid tenant', () => {
  test('renders list with items from correct tenant only', async () => {
    await insertItemDirect(tenantA.id, 'Item A');
    await insertItemDirect(tenantB.id, 'Item B');

    const res = await request(app)
      .get('/app')
      .set('Cookie', [cookieA()]);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Item A');
    expect(res.text).not.toContain('Item B');
  });
});

describe('POST /app/add', () => {
  test('adds item to correct tenant', async () => {
    const res = await request(app)
      .post('/app/add')
      .set('Cookie', [cookieA()])
      .send('item=Feij%C3%A3o');

    expect(res.status).toBe(302);

    await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantA.id]);
    const items = await db('items').where({ tenant_id: tenantA.id });
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe('Feijão');
  });

  test('returns 400 if item is empty', async () => {
    const res = await request(app)
      .post('/app/add')
      .set('Cookie', [cookieA()])
      .send('item=');
    expect(res.status).toBe(400);
  });
});

describe('POST /app/check', () => {
  test('marks item as checked', async () => {
    const item = await insertItemDirect(tenantA.id, 'Leite');

    await request(app)
      .post('/app/check')
      .set('Cookie', [cookieA()])
      .send(`id=${item.id}&checked=on`);

    await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantA.id]);
    const updated = await db('items').where({ id: item.id }).first();
    expect(updated.checked).toBe(true);
  });

  test('tenant B cannot check tenant A items', async () => {
    const item = await insertItemDirect(tenantA.id, 'Protected');

    await request(app)
      .post('/app/check')
      .set('Cookie', [cookieB()])
      .send(`id=${item.id}&checked=on`);

    await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantA.id]);
    const untouched = await db('items').where({ id: item.id }).first();
    expect(untouched.checked).toBe(false);
  });
});

describe('POST /app/clear-checked', () => {
  test('archives checked items of tenant', async () => {
    await insertItemDirect(tenantA.id, 'ToArchive');
    await db('items').where({ tenant_id: tenantA.id }).update({ checked: true });

    const res = await request(app)
      .post('/app/clear-checked')
      .set('Cookie', [cookieA()]);

    expect(res.status).toBe(302);
    await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantA.id]);
    const archived = await db('items').where({ tenant_id: tenantA.id, archived: true });
    expect(archived).toHaveLength(1);
  });
});

describe('POST /app/check-archived', () => {
  test('returns archived items of tenant only', async () => {
    await insertItemDirect(tenantA.id, 'Arch');
    await db('items').where({ tenant_id: tenantA.id }).update({ archived: true, archived_at: db.fn.now() });
    await insertItemDirect(tenantB.id, 'Other Arch');
    await db('items').where({ tenant_id: tenantB.id }).update({ archived: true, archived_at: db.fn.now() });

    const res = await request(app)
      .post('/app/check-archived')
      .set('Cookie', [cookieA()]);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].item).toBe('Arch');
  });
});

describe('DELETE /app/remove-archived', () => {
  test('removes only archived items of tenant', async () => {
    await insertItemDirect(tenantA.id, 'ToDelete');
    await db('items').where({ tenant_id: tenantA.id }).update({ archived: true });
    await insertItemDirect(tenantB.id, 'Keep');
    await db('items').where({ tenant_id: tenantB.id }).update({ archived: true });

    const res = await request(app)
      .delete('/app/remove-archived')
      .set('Cookie', [cookieA()]);

    expect(res.status).toBe(200);

    await db.raw(`SELECT set_config('app.current_tenant_id', ?, false)`, [tenantB.id]);
    const remaining = await db('items').where({ tenant_id: tenantB.id, archived: true });
    expect(remaining).toHaveLength(1);
  });
});
