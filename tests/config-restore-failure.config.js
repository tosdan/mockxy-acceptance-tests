const path = require("path");

// Configurazione del processo Playwright figlio che esegue config-restore-failure.inner.js (vedi
// runtime-config-restart.spec.js). Nessun setup globale né retry: un test alla volta, report JSON.
// Il timeout è più breve della pausa dello spec interno: senza un budget proprio, il ripristino
// negli hook scadrebbe prima che l'istanza torni raggiungibile.
//
// CONFIG_RESTORE_RUN_DIR è la cartella temporanea dell'esecuzione, creata e rimossa dal test
// esterno: lì vanno gli artefatti del figlio, che altrimenti svuoterebbe test-results della suite.
const runDir = process.env.CONFIG_RESTORE_RUN_DIR;
if (!runDir) {
  throw new Error("CONFIG_RESTORE_RUN_DIR mancante: questo config lo usa solo runtime-config-restart.spec.js");
}

module.exports = {
  testDir: __dirname,
  testMatch: /config-restore-failure\.inner\.js$/,
  outputDir: path.join(runDir, "results"),
  workers: 1,
  retries: 0,
  timeout: 8000,
  reporter: [["json"]],
};
