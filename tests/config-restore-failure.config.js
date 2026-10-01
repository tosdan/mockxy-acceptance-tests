// Configurazione del processo Playwright figlio che esegue config-restore-failure.inner.js (vedi
// runtime-config-restart.spec.js). Nessun setup globale né retry: un test alla volta, report JSON.
// Il timeout è più breve della pausa dello spec interno: senza un budget proprio, il ripristino
// negli hook scadrebbe prima che l'istanza torni raggiungibile.
module.exports = {
  testDir: __dirname,
  testMatch: /config-restore-failure\.inner\.js$/,
  workers: 1,
  retries: 0,
  timeout: 8000,
  reporter: [["json"]],
};
