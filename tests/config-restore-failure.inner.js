const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { test } = require("@playwright/test");
const { SERVICE, FAILURE_PAUSE_MS, installStartupRestore, applyOverrides } = require("./config-restore");

// Spec INTERNO, non fa parte della suite: lo esegue runtime-config-restart.spec.js in un processo
// Playwright figlio (config-restore-failure.config.js), per verificare dall'esterno che il
// ripristino di config-restore.js regga i fallimenti. Entrambi i test falliscono di proposito.

const COMPOSE_DIR = path.join(__dirname, "..");
// Cartella temporanea dell'esecuzione, condivisa col test esterno (vedi il config del figlio).
const RUN_DIR = process.env.CONFIG_RESTORE_RUN_DIR;

test.describe("fallimenti dopo gli override", () => {
  installStartupRestore(test);

  test("errore subito dopo gli override", async ({ request }) => {
    await applyOverrides(request);
    throw new Error("docker compose restart fallito (simulato)");
  });

  test("scadenza con l'istanza irraggiungibile", async ({ request }) => {
    test.setTimeout(5000);
    await applyOverrides(request);
    // Istanza irraggiungibile più a lungo del budget normale di un hook. La pausa deve riuscire;
    // i marcatori registrano quando inizia e quando finisce, e quello di fine nasce solo se
    // l'unpause riesce, cioè se il container era ancora in pausa: una riattivazione anticipata
    // da altri lo farebbe mancare. La ripresa la esegue un processo staccato dal worker.
    execFileSync("docker", ["compose", "pause", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" });
    fs.writeFileSync(path.join(RUN_DIR, "paused-at"), String(Date.now()));
    const writeResumedAt = `require("fs").writeFileSync(${JSON.stringify(path.join(RUN_DIR, "resumed-at"))}, String(Date.now()))`;
    spawn("sh", ["-c", `sleep ${FAILURE_PAUSE_MS / 1000} && docker compose unpause ${SERVICE} && node -e '${writeResumedAt}'`], {
      cwd: COMPOSE_DIR,
      stdio: "ignore",
      detached: true,
    }).unref();
    await new Promise(() => {});
  });
});
