// Helper condiviso, importato dagli handler con l'alias `#shared/`. Importa a sua volta un
// altro helper con lo stesso alias: la risoluzione vale anche dentro gli helper, non solo per
// lo script che il motore compila direttamente.
const { LINGUE } = require("#shared/saluti/lingue.js");

function saluta(nome, lingua = "it") {
  return `${LINGUE[lingua] ?? LINGUE.it}, ${nome}!`;
}

module.exports = { saluta };
