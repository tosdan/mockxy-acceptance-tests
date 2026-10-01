const { execFileSync } = require("child_process");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");
const { adminJson, adminSend } = require("./admin-client");

// Configurazione effimera via PATCH /config (piano agent/API, §13 C8) nell'immagine distribuita:
// gli override cambiano il traffico nuovo visto dal browser, mentre una richiesta già entrata e un
// tunnel WebSocket aperto restano sulla configurazione con cui sono partiti. Il riavvio che li
// elimina è in runtime-config-restart.spec.js, in un project isolato.

const BASE = stack.mockxyConfigBaseUrl;
const WS_BASE = BASE.replace("http", "ws");
const COMPOSE_DIR = path.join(__dirname, "..");
const SERVICE = "mockxy-config";
const BACKEND_A = "http://backend:9000";
const BACKEND_B = "http://backend-b:9000";
const ENTRY_LOG_TIMEOUT_MS = 10000;

let sequence = 0;
/** Path unico sotto /identity/: nessuna richiesta di altri test o tentativi lo condivide. */
function uniqueIdentityPath(label) {
  sequence += 1;
  return `/identity/${label}-${Date.now()}-${sequence}`;
}

async function patchConfig(request, body) {
  return adminSend(request, BASE, "PATCH", "/config", body);
}

/** Toglie ogni override: la configurazione effettiva torna quella di avvio. */
async function restoreStartup(request) {
  const current = await adminJson(request, BASE, "/config");
  const keys = Object.keys(current.overrides);
  const state = keys.length > 0 ? await patchConfig(request, { unset: keys }) : current;
  expect(state.overrides).toEqual({});
  expect(state.effective).toEqual(state.startup);
  return state;
}

async function arrivals(request, backendBaseUrl, identityPath) {
  const response = await request.get(`${backendBaseUrl}/api/arrivals?path=${encodeURIComponent(identityPath)}`);
  return (await response.json()).count;
}

function callFromBrowser(page, url) {
  return page.evaluate((target) => window.callApi(target), url);
}

/**
 * Attende nel log del container la riga con cui il motore accoglie la richiesta. Il motore la
 * scrive e subito dopo, senza attese in mezzo, fotografa la configurazione della richiesta:
 * quando la riga compare, la richiesta ha già la sua configurazione e un PATCH successivo non
 * può più cambiarla.
 */
async function waitForEntryLog(method, requestPath, sinceIso) {
  const deadline = Date.now() + ENTRY_LOG_TIMEOUT_MS;
  let lines = [];
  while (Date.now() < deadline) {
    const output = execFileSync("docker", ["compose", "logs", "--no-log-prefix", "--no-color", "--since", sinceIso, SERVICE], {
      cwd: COMPOSE_DIR,
      encoding: "utf8",
    });
    lines = output.split("\n").filter(Boolean);
    const entered = lines.some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.msg === "Request received." && entry.method === method && entry.path === requestPath;
      } catch {
        return false;
      }
    });
    if (entered) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`nessuna riga "Request received." per ${method} ${requestPath} entro ${ENTRY_LOG_TIMEOUT_MS} ms. Ultime righe:\n${lines.slice(-20).join("\n")}`);
}

test.describe("configurazione effimera e connessioni esistenti", () => {
  // Configurazione dell'istanza e contatori dei backend sono stato condiviso: una sola
  // esecuzione (Chromium), in ordine in un solo worker. Ogni test parte e finisce senza override.
  // La semantica CORS sui tre motori è già coperta da cors.spec.js.
  test.describe.configure({ mode: "default" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stato condiviso dell'istanza mockxy-config: una sola esecuzione, in ordine"
  );

  test.beforeEach(async ({ page, request }) => {
    const state = await restoreStartup(request);
    expect(state.startup.backendUrl).toBe(BACKEND_A);
    await page.goto("/");
  });

  // Anche dopo un fallimento: chiude i tunnel del browser e toglie gli override.
  test.afterEach(async ({ page, request }) => {
    await page.evaluate(() => window.wsCloseAll()).catch(() => {});
    await restoreStartup(request);
  });

  test("un override cambia GET /config, la revisione config e la richiesta successiva del browser (CORS)", async ({ page, request }) => {
    const revisionBefore = (await adminJson(request, BASE, "/info")).revisions.config;
    // GET semplici, senza header che richiedano un preflight: nessuna cache del browser in gioco.
    // La query unica evita anche la cache HTTP.
    const readable = async (label) => !(await callFromBrowser(page, `${BASE}/agent-ready?n=${label}-${Date.now()}`)).blocked;
    expect(await readable("avvio"), "CORS attivo all'avvio").toBe(true);

    const disabled = await patchConfig(request, { set: { corsEnabled: false } });
    expect(disabled).toMatchObject({ overrides: { corsEnabled: false }, effective: { corsEnabled: false }, startup: { corsEnabled: true }, persisted: false });
    expect((await adminJson(request, BASE, "/config")).overrides).toEqual({ corsEnabled: false });
    const revisionDisabled = (await adminJson(request, BASE, "/info")).revisions.config;
    expect(revisionDisabled, "la revisione config avanza").toBeGreaterThan(revisionBefore);
    expect(await readable("spento"), "con l'override il browser blocca la risposta").toBe(false);

    // Un override uguale al valore di avvio resta esplicito finché non viene tolto.
    const explicit = await patchConfig(request, { set: { corsEnabled: true } });
    expect(explicit.overrides).toEqual({ corsEnabled: true });
    expect(await readable("esplicito")).toBe(true);

    const restored = await patchConfig(request, { unset: ["corsEnabled"] });
    expect(restored.overrides).toEqual({});
    expect(await readable("ripristinato")).toBe(true);
  });

  test("backendUrl: null disattiva il backend, unset ripristina quello di avvio", async ({ page, request }) => {
    const toB = uniqueIdentityPath("verso-b");
    await patchConfig(request, { set: { backendUrl: BACKEND_B } });
    expect((await callFromBrowser(page, `${BASE}${toB}`)).body).toMatchObject({ backend: "b" });

    const disabled = await patchConfig(request, { set: { backendUrl: null } });
    expect(disabled).toMatchObject({ overrides: { backendUrl: null }, effective: { backendUrl: null }, startup: { backendUrl: BACKEND_A } });
    const withoutBackend = uniqueIdentityPath("senza-backend");
    const refused = await callFromBrowser(page, `${BASE}${withoutBackend}`);
    expect(refused).toMatchObject({ blocked: false, status: 501, headers: { "x-mock-source": "backend-unconfigured" } });
    expect(await arrivals(request, stack.backendDirectBaseUrl, withoutBackend)).toBe(0);
    expect(await arrivals(request, stack.backendBDirectBaseUrl, withoutBackend)).toBe(0);

    const restored = await patchConfig(request, { unset: ["backendUrl"] });
    expect(restored).toMatchObject({ overrides: {}, effective: { backendUrl: BACKEND_A } });
    const backToA = uniqueIdentityPath("di-nuovo-a");
    expect((await callFromBrowser(page, `${BASE}${backToA}`)).body).toMatchObject({ backend: "a" });
  });

  test("una richiesta già entrata e ancora nel ritardo resta sul backend vecchio; la successiva va sul nuovo", async ({ page, request }) => {
    await patchConfig(request, { set: { globalDelayMs: 3000, delayAllRequests: true } });
    const inflightPath = uniqueIdentityPath("in-volo");
    const url = `${BASE}${inflightPath}`;
    const since = new Date(Date.now() - 1000).toISOString();

    await page.evaluate((target) => {
      window.__inflight = window.callApi(target);
    }, url);
    // Barriera osservabile: la richiesta è entrata e ha fotografato la configurazione.
    await waitForEntryLog("GET", inflightPath, since);
    await patchConfig(request, { set: { backendUrl: BACKEND_B } });

    // Condizione della prova: il cambio è avvenuto mentre la richiesta era ancora nel ritardo.
    const arrivedBeforeSwitch = {
      a: await arrivals(request, stack.backendDirectBaseUrl, inflightPath),
      b: await arrivals(request, stack.backendBDirectBaseUrl, inflightPath),
    };
    expect(
      arrivedBeforeSwitch,
      "la richiesta ha raggiunto un backend prima che il cambio fosse applicato: la prova non ha stabilito le sue condizioni"
    ).toEqual({ a: 0, b: 0 });

    const first = await page.evaluate(() => window.__inflight);
    expect(first).toMatchObject({ blocked: false, status: 200, body: { backend: "a", path: inflightPath } });
    const next = await callFromBrowser(page, url);
    expect(next).toMatchObject({ blocked: false, status: 200, body: { backend: "b", path: inflightPath } });
    expect(await arrivals(request, stack.backendDirectBaseUrl, inflightPath)).toBe(1);
    expect(await arrivals(request, stack.backendBDirectBaseUrl, inflightPath)).toBe(1);
  });

  test("un tunnel WebSocket aperto resta sul backend di origine; una connessione nuova usa il nuovo", async ({ page, request }) => {
    const url = `${WS_BASE}/ws/identity`;
    expect((await page.evaluate((target) => window.wsOpen("prima", target), url)).opened).toBe(true);
    await expect.poll(async () => (await page.evaluate(() => window.wsState("prima"))).received).toEqual(["hello from backend a"]);

    await patchConfig(request, { set: { backendUrl: BACKEND_B } });

    await page.evaluate(() => window.wsSend("prima", "dopo il cambio"));
    await expect
      .poll(async () => page.evaluate(() => window.wsState("prima")))
      .toEqual({ received: ["hello from backend a", "echo from a: dopo il cambio"], closed: null });

    expect((await page.evaluate((target) => window.wsOpen("dopo", target), url)).opened).toBe(true);
    await expect.poll(async () => (await page.evaluate(() => window.wsState("dopo"))).received).toEqual(["hello from backend b"]);
  });
});
