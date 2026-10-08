// Stesso import a qualsiasi profondità della cartella: è il punto dell'alias `#shared/`.
const { saluta } = require("#shared/saluti/formato.js");

module.exports = {
  resolveResponse({ params, query }) {
    return { status: 200, jsonBody: { saluto: saluta(params.nome, query.lingua), profondita: 5 } };
  },
};
