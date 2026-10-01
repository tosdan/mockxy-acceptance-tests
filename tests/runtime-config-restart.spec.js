const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { test, expect } = require("@playwright/test");
const { adminJson } = require("./admin-client");
const { BASE, SERVICE, FAILURE_PAUSE_MS, installStartupRestore, applyOverrides, waitForRuntime } = require("./config-restore");

// Il riavvio elimina gli override della configurazione effimera (piano agent/API, §13 C8): nuovo
// runtimeId, overrides vuoti ed effective uguale a startup; il vecchio cursore del Monitor
// segnala runtime_changed. Riavvia e mette in pausa un container: gira nel project
// chromium-config-restart, dopo tutti gli altri e mai in concorrenza (vedi playwright.config.js).

const COMPOSE_DIR = path.join(__dirname, "..");
const FAILURE_CONFIG = path.join(__dirname, "config-restore-failure.config.js");

const MARKER_TIMEOUT_MS = 30000;

async function readMarker(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      return Number(fs.readFileSync(file, "utf8"));
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Esegue un test di config-restore-failure.inner.js in un processo Playwright figlio, con una
 * cartella temporanea propria per artefatti e marcatori, e ne restituisce lo stato e gli istanti
 * di pausa e ripresa dell'istanza (null se il test non l'ha messa in pausa). Il ripristino si
 * verifica dall'esterno, a processo concluso.
 */
async function runInnerFailure(testInfo, title) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mockxy-config-restore-"));
  // Un artefatto della suite principale deve sopravvivere al processo figlio.
  const sentinel = testInfo.outputPath("artefatto-della-suite.txt");
  fs.writeFileSync(sentinel, "deve restare dopo il processo figlio\n");
  let stdout;
  let pausedAt = null;
  let resumedAt = null;
  try {
    try {
      ({ stdout } = await promisify(execFile)("npx", ["playwright", "test", "-c", FAILURE_CONFIG, "-g", title], {
        cwd: COMPOSE_DIR,
        env: { ...process.env, CONFIG_RESTORE_RUN_DIR: runDir },
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      stdout = error.stdout; // il test interno fallisce di proposito: exit code diverso da zero
    }
    pausedAt = await readMarker(path.join(runDir, "paused-at"), 0);
    if (pausedAt != null) {
      // La ripresa la scrive il processo staccato, subito dopo l'unpause riuscito.
      resumedAt = await readMarker(path.join(runDir, "resumed-at"), MARKER_TIMEOUT_MS);
    }
  } finally {
    // Anche se qualcosa è andato storto, l'istanza non resta in pausa.
    try {
      execFileSync("docker", ["compose", "unpause", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" });
    } catch {
      /* non era in pausa */
    }
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  expect(fs.existsSync(sentinel), "il processo figlio non tocca gli artefatti della suite").toBe(true);
  const report = JSON.parse(stdout);
  const results = report.suites.flatMap(function collect(suite) {
    return [...(suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((t) => t.results)), ...(suite.suites ?? []).flatMap(collect)];
  });
  expect(results, `un solo risultato per "${title}"`).toHaveLength(1);
  return { result: results[0], pausedAt, resumedAt };
}

test.describe("riavvio della configurazione effimera", () => {
  // Tre test sulla stessa istanza: in ordine, in un solo worker.
  test.describe.configure({ mode: "default" });
  installStartupRestore(test);

  test("un errore subito dopo gli override non li lascia sull'istanza", async ({ request }, testInfo) => {
    test.setTimeout(120000);
    const { result } = await runInnerFailure(testInfo, "errore subito dopo gli override");
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("simulato");

    const config = await adminJson(request, BASE, "/config");
    expect(config.overrides).toEqual({});
    expect(config.effective).toEqual(config.startup);
  });

  test("una scadenza del test con l'istanza irraggiungibile non lascia override", async ({ request }, testInfo) => {
    test.setTimeout(120000);
    const { result, pausedAt, resumedAt } = await runInnerFailure(testInfo, "scadenza con l'istanza irraggiungibile");
    expect(result.status).toBe("timedOut");
    // Condizione della prova: l'istanza è rimasta in pausa per tutta la durata prevista, oltre il
    // budget normale dell'hook. Il marcatore di ripresa esiste solo se l'unpause è riuscito, cioè
    // se nessun altro l'aveva già riattivata: senza, la prova sarebbe inconcludente.
    expect(pausedAt, "la pausa dell'istanza non è riuscita").not.toBeNull();
    expect(resumedAt, "l'istanza non era più in pausa alla ripresa prevista: la prova non ha stabilito le sue condizioni").not.toBeNull();
    expect(resumedAt - pausedAt, "durata effettiva della pausa").toBeGreaterThanOrEqual(FAILURE_PAUSE_MS);

    // Se il ripristino non l'ha già fatto, l'istanza è appena uscita dalla pausa.
    await waitForRuntime(request);
    const config = await adminJson(request, BASE, "/config");
    expect(config.overrides).toEqual({});
    expect(config.effective).toEqual(config.startup);
  });

  test("il riavvio elimina gli override e il vecchio cursore del Monitor segnala runtime_changed", async ({ page, request }) => {
    const before = await adminJson(request, BASE, "/info");
    const overridden = await applyOverrides(request);
    const cursor = (await adminJson(request, BASE, "/monitoring/requests?view=page&since=latest")).cursor;
    expect(cursor.runtimeId).toBe(before.runtimeId);

    execFileSync("docker", ["compose", "restart", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" });
    const after = await waitForRuntime(request, before.runtimeId);

    const config = await adminJson(request, BASE, "/config");
    expect(config.runtimeId).toBe(after.runtimeId);
    expect(config.overrides).toEqual({});
    expect(config.effective).toEqual(config.startup);
    expect(config.startup).toEqual(overridden.startup);
    expect(config.persisted).toBe(false);
    expect(after.revisions.config).toBe(1);

    // Il traffico nuovo usa di nuovo la configurazione di avvio: backend "a" e CORS attivo.
    await page.goto("/");
    const served = await page.evaluate((url) => window.callApi(url), `${BASE}/identity/dopo-il-riavvio-${Date.now()}`);
    expect(served).toMatchObject({ blocked: false, status: 200, body: { backend: "a" } });

    const query = new URLSearchParams({ view: "page", since: cursor.since, runtimeId: cursor.runtimeId, generation: String(cursor.generation) });
    const monitorPage = await adminJson(request, BASE, `/monitoring/requests?${query}`);
    expect(monitorPage).toMatchObject({ gap: true, gapReason: "runtime_changed" });
    expect(monitorPage.cursor.runtimeId).toBe(after.runtimeId);
  });
});
