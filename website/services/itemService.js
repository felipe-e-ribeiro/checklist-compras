function withTenant(tenantId, db, fn) {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_tenant_id', ?, true)`, [tenantId]);
    return fn(trx);
  });
}

async function listItems(tenantId, sortBy, db) {
  return withTenant(tenantId, db, (trx) => {
    const query = trx('items').where({ tenant_id: tenantId, archived: false });
    if (sortBy === 'checked') {
      query.orderBy([{ column: 'checked', order: 'asc' }, { column: 'item', order: 'asc' }]);
    } else {
      query.orderBy([{ column: 'item', order: 'asc' }, { column: 'checked', order: 'desc' }]);
    }
    return query;
  });
}

async function addItem(tenantId, itemText, db) {
  return withTenant(tenantId, db, async (trx) => {
    const [item] = await trx('items')
      .insert({ tenant_id: tenantId, item: itemText, checked: false })
      .returning('*');
    return item;
  });
}

async function checkItem(tenantId, id, checked, db) {
  return withTenant(tenantId, db, (trx) =>
    trx('items').where({ id, tenant_id: tenantId }).update({ checked })
  );
}

async function archiveChecked(tenantId, db) {
  return withTenant(tenantId, db, (trx) =>
    trx('items')
      .where({ tenant_id: tenantId, checked: true, archived: false })
      .update({ archived: true, archived_at: trx.fn.now() })
  );
}

async function listArchived(tenantId, db) {
  return withTenant(tenantId, db, (trx) =>
    trx('items')
      .select('id', 'item', 'archived_at')
      .where({ tenant_id: tenantId, archived: true })
  );
}

async function deleteArchived(tenantId, db) {
  return withTenant(tenantId, db, (trx) =>
    trx('items').where({ tenant_id: tenantId, archived: true }).del()
  );
}

module.exports = { listItems, addItem, checkItem, archiveChecked, listArchived, deleteArchived };
