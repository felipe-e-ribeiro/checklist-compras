// Fecha o pool de conexões do Knex após todos os testes.
// Sem isto, o Jest fica suspenso aguardando conexões abertas
// e precisa do --forceExit como workaround.
module.exports = async () => {
  const { destroyDb } = require('./dbSetup');
  await destroyDb();
};
