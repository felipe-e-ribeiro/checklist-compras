exports.up = (knex) =>
  knex.schema.table('items', (t) => {
    t.string('quantity', 25).nullable();
    t.boolean('is_critical').notNullable().defaultTo(false);
  });

exports.down = (knex) =>
  knex.schema.table('items', (t) => {
    t.dropColumn('quantity');
    t.dropColumn('is_critical');
  });
