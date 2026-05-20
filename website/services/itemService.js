async function listItems(tenantId, sortBy, db) {
  const query = db('items').where({ tenant_id: tenantId, archived: false });

  if (sortBy === 'checked') {
    query.orderBy([
      { column: 'checked', order: 'asc' },
      { column: 'item', order: 'asc' },
    ]);
  } else {
    query.orderBy([
      { column: 'item', order: 'asc' },
      { column: 'checked', order: 'desc' },
    ]);
  }

  return query;
}

async function addItem(tenantId, itemText, db) {
  const [item] = await db('items')
    .insert({ tenant_id: tenantId, item: itemText, checked: false })
    .returning('*');
  return item;
}

async function checkItem(tenantId, id, checked, db) {
  await db('items').where({ id, tenant_id: tenantId }).update({ checked });
}

async function archiveChecked(tenantId, db) {
  const count = await db('items')
    .where({ tenant_id: tenantId, checked: true, archived: false })
    .update({ archived: true, archived_at: db.fn.now() });
  return count;
}

async function listArchived(tenantId, db) {
  return db('items')
    .select('id', 'item', 'archived_at')
    .where({ tenant_id: tenantId, archived: true });
}

async function deleteArchived(tenantId, db) {
  return db('items').where({ tenant_id: tenantId, archived: true }).del();
}

module.exports = { listItems, addItem, checkItem, archiveChecked, listArchived, deleteArchived };
