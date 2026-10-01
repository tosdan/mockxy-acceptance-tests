const { spawn } = require("child_process");
const path = require("path");
const { test } = require("@playwright/test");
const { SERVICE, FAILURE_PAUSE_MS, installStartupRestore, applyOverrides } = require("./config-restore");

// Spec INTERNO, non fa parte della suite: lo esegue runtime-config-restart.spec.js in un processo
// Playwright figlio (config-restore-failure.config.js), per verificare dall'esterno che il
// ripristino di config-restore.js regga i fallimenti. Entrambi i test falliscono di proposito.

const COMPOSE_DIR = path.join(__dirname, "..");

test.describe("fallimenti dopo gli override", () => {
  installStartupRestore(test);

  test("errore subito dopo gli override", async ({ request }) => {
    await applyOverrides(request);
    throw new Error("docker compose restart fallito (simulato)");
  });

  test("scadenza con l'istanza irraggiungibile", async ({ request }) => {
    test.setTimeout(5000);
    await applyOverrides(request);
    // Istanza irraggiungibile più a lungo del timeout del test: la riattiva un processo
    // staccato, indipendente da questo worker.
    spawn("docker", ["compose", "pause", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" }).on("exit", () => {
      spawn("sh", ["-c", `sleep ${FAILURE_PAUSE_MS / 1000} && docker compose unpause ${SERVICE}`], {
        cwd: COMPOSE_DIR,
        stdio: "ignore",
        detached: true,
      }).unref();
    });
    await new Promise(() => {});
  });
});
