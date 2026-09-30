const http = require("http");
const { test, expect } = require("@playwright/test");
const YAML = require("yaml");
const stack = require("./stack");
const { adminJson, adminSend } = require("./admin-client");
const { AgentSetup, SetupError } = require("./agent-setup");

// Setup ripetibile via API, browser e Monitor nell'immagine distribuita (piano agent/API, §13 C6):
// lo stesso helper, da stati di partenza diversi e senza ripristino fra un caso e l'altro, dà lo
// stesso risultato nel browser, che chiama Mockxy da un'altra origine, e lo stesso traffico nel
// Monitor. L'istanza mockxy-setup parte con il CORS spento: lo ottiene solo dal setup.

const BASE = stack.mockxySetupBaseUrl;
const MOCKS_DIR = "/workspace/mocks";

const ORDERS = { method: "GET", path: "/agent-test/orders", target: "001.response.json", alternative: "002.response.json" };
const PROGRESS = { method: "GET", path: "/agent-test/progress", pending: "001.response.json", done: "002.response.json", sequence: "003.response.json" };
const NOTES = { method: "GET", path: "/agent-test/notes", file: "001.response.json" };

// Configurazione runtime da cui dipende la prova: il CORS per la pagina nginx e nessun ritardo.
const DECLARED_CONFIG = { corsEnabled: true, globalDelayMs: 0, delayAllRequests: false };

// Contenuti dichiarati per intero: un aggiornamento conserva i campi omessi, quindi un ritardo o
// il templating lasciati da una prova precedente resterebbero.
const JSON_HEADERS = { "content-type": "application/json" };
const MOCK_DEFAULTS = { type: "mock", headers: JSON_HEADERS, delayMs: 0, templated: false };
const ORDERS_TARGET = { ...MOCK_DEFAULTS, title: "Ordini", status: 200, body: { orders: [{ id: "o-1" }] } };
const PROGRESS_PENDING = { ...MOCK_DEFAULTS, title: "In corso", status: 202, body: { state: "pending" } };
const PROGRESS_DONE = { ...MOCK_DEFAULTS, title: "Completato", status: 200, body: { state: "done" } };
const PROGRESS_SEQUENCE = {
  type: "sequence",
  title: "Avanzamento",
  steps: [{ response: PROGRESS.pending, times: 1 }, { response: PROGRESS.done }],
  onEnd: "stay",
  resetAfterMs: null,
};

const isOrders = (item) => item.method === "GET" && item.path === ORDERS.path;
const isProgress = (item) => item.method === "GET" && item.path === PROGRESS.path;

async function connect(request) {
  const setup = new AgentSetup(request, BASE);
  await setup.connect({ mocksDir: MOCKS_DIR });
  return setup;
}

/** Il setup completo: configurazione, contenuti con la revisione letta, attivazione, reset. */
async function setupScenario(setup) {
  await setup.declareConfig(DECLARED_CONFIG);
  const orders = await setup.findEndpoint(ORDERS.method, ORDERS.path);
  const progress = await setup.findEndpoint(PROGRESS.method, PROGRESS.path);
  await setup.requireVariants(orders.id, [ORDERS.target, ORDERS.alternative]);
  await setup.requireVariants(progress.id, [PROGRESS.pending, PROGRESS.done, PROGRESS.sequence]);

  // Sono varianti che il setup riattiva e azzera subito dopo: riscriverle anche se attive è voluto.
  await setup.prepareVariant(orders.id, ORDERS.target, ORDERS_TARGET, { allowActive: true });
  await setup.prepareVariant(progress.id, PROGRESS.pending, PROGRESS_PENDING, { allowActive: true });
  await setup.prepareVariant(progress.id, PROGRESS.done, PROGRESS_DONE, { allowActive: true });
  await setup.prepareVariant(progress.id, PROGRESS.sequence, PROGRESS_SEQUENCE, { allowActive: true });

  await setup.serveMocks();
  await setup.select(orders.id, ORDERS.target);
  await setup.select(progress.id, PROGRESS.sequence);
  await setup.setEnabled([orders.id, progress.id], true);
  await setup.resetSequence(progress.id);
  return { orders: orders.id, progress: progress.id };
}

/**
 * Una variante preparata con select: false e letta per filename non cambia risposta servita,
 * selezione né cursore della sequence. La risposta servita si confronta con una richiesta vera
 * mentre la bozza esiste: la sua cancellazione ricarica il runtime e nasconderebbe un errore. Uno step della sequence selezionata, invece, è attivo pur
 * non essendo selezionato: non è un esempio di preparazione inattiva.
 */
async function expectInactivePreparation(setup, ids) {
  const step = await setup.readVariant(ids.progress, PROGRESS.pending);
  expect(step, "uno step della sequence selezionata è attivo").toMatchObject({ selected: false, active: true });

  // L'endpoint statico non consuma la sequence: si può interrogare senza toccare il cursore.
  const servedOrders = async () => {
    const response = await setup.request.get(`${BASE}${ORDERS.path}`);
    return { status: response.status(), body: await response.json() };
  };
  const before = {
    served: await servedOrders(),
    orders: await setup.read(`/mocks/${ids.orders}`, "Reading orders"),
    progress: await setup.read(`/mocks/${ids.progress}`, "Reading progress"),
    cursor: await setup.read(`/mocks/${ids.progress}/sequence/state`, "Reading the sequence state"),
  };
  const draft = await setup.createInactiveVariant(ids.orders, { ...MOCK_DEFAULTS, title: "Bozza", status: 418, body: { draft: true } });
  try {
    expect(draft).toMatchObject({ selected: false, active: false, response: { status: 418 } });
    expect(await servedOrders(), "risposta realmente servita invariata, con la bozza presente").toEqual(before.served);
    const after = {
      orders: await setup.read(`/mocks/${ids.orders}`, "Reading orders"),
      progress: await setup.read(`/mocks/${ids.progress}`, "Reading progress"),
      cursor: await setup.read(`/mocks/${ids.progress}/sequence/state`, "Reading the sequence state"),
    };
    expect(after.orders.selectedResponseFile).toBe(ORDERS.target);
    expect(after.orders.responseRevision, "risposta servita di orders invariata").toBe(before.orders.responseRevision);
    expect(after.progress.selectedResponseFile).toBe(PROGRESS.sequence);
    expect(after.cursor, "cursore della sequence invariato").toEqual(before.cursor);
  } finally {
    await setup.mutate("DELETE", `/mocks/${ids.orders}/responses/${draft.responseFile}`, undefined, "Removing the prepared variant");
  }
}

/** Setup, preparazione inattiva, cursore, azione del browser e verifica nel Monitor. */
async function runScenario(page, setup) {
  const ids = await setupScenario(setup);
  await expectInactivePreparation(setup, ids);

  // Il cursore si prende dopo preparazione, attivazione e reset, prima dell'azione del browser.
  const cursor = await setup.monitorCursor();

  // Fetch reali dalla pagina nginx, un'altra origine: nessuna intercettazione delle risposte.
  await page.goto("/");
  const results = await page.evaluate(async (base) => {
    const orders = await window.callApi(`${base}/agent-test/orders`);
    const first = await window.callApi(`${base}/agent-test/progress`);
    const second = await window.callApi(`${base}/agent-test/progress`);
    return [orders, first, second].map(({ blocked, status, body }) => ({ blocked, status, body }));
  }, BASE);
  expect(results).toEqual([
    { blocked: false, status: 200, body: { orders: [{ id: "o-1" }] } },
    { blocked: false, status: 202, body: { state: "pending" } },
    { blocked: false, status: 200, body: { state: "done" } },
  ]);

  // Fra le voci successive al cursore, a pagine piccole per attraversarne più d'una, senza
  // pretendere che siano solo queste: gli healthcheck e altro traffico accessorio non contano.
  const traffic = await setup.readTraffic(cursor, {}, {
    limit: 2,
    until: (items) => items.filter(isOrders).length >= 1 && items.filter(isProgress).length >= 2,
  });
  expect(traffic.pages.length, "più pagine attraversate").toBeGreaterThan(1);
  expect(traffic.pages.every((page) => page.gap === false), "nessun gap su ogni pagina").toBe(true);
  expect(traffic.items.filter(isOrders).map((item) => item.status)).toEqual([200]);
  expect(traffic.items.filter(isProgress).map((item) => item.status)).toEqual([202, 200]);
}

async function served(request, routePath) {
  const response = await request.get(`${BASE}${routePath}`);
  return { status: response.status(), body: await response.json().catch(() => null) };
}

test.describe("setup ripetibile via API, browser e Monitor", () => {
  // Catalogo, modalità server, configurazione runtime e Monitor dell'istanza sono stato
  // condiviso: una sola esecuzione (Chromium), in ordine in un solo worker. I casi non ripristinano
  // niente fra loro: è proprio ciò che dimostrano. La semantica CORS nel browser è già coperta sui
  // tre motori da cors.spec.js.
  test.describe.configure({ mode: "default" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stato condiviso dell'istanza mockxy-setup: una sola esecuzione, in ordine"
  );

  test("A: parte con l'alternativa selezionata, la sequence consumata, ritardi e CORS spento", async ({ page, request }) => {
    const setup = await connect(request);
    const orders = await setup.findEndpoint(ORDERS.method, ORDERS.path);
    const progress = await setup.findEndpoint(PROGRESS.method, PROGRESS.path);
    await setup.serveMocks();
    await setup.select(orders.id, ORDERS.alternative);
    await setup.setEnabled([orders.id, progress.id], true);
    // Una prova precedente ha lasciato sul bersaglio un ritardo lungo e il templating acceso.
    await adminSend(request, BASE, "PUT", `/mocks/${orders.id}/responses/${ORDERS.target}`, { type: "mock", delayMs: 30000, templated: true });
    // La sequence si consuma prima del setup, mai fra il reset e la prova.
    await setup.select(progress.id, PROGRESS.sequence);
    await served(request, PROGRESS.path);
    await served(request, PROGRESS.path);
    // E ha lasciato la configurazione runtime: CORS spento e un ritardo globale.
    await adminSend(request, BASE, "PATCH", "/config", { set: { corsEnabled: false, globalDelayMs: 1500, delayAllRequests: true } });
    expect((await served(request, ORDERS.path)).status).toBe(503);

    await runScenario(page, setup);
  });

  test("B: parte con gli endpoint disabilitati e Proxy All attivo", async ({ page, request }) => {
    const setup = await connect(request);
    const orders = await setup.findEndpoint(ORDERS.method, ORDERS.path);
    const progress = await setup.findEndpoint(PROGRESS.method, PROGRESS.path);
    await setup.setEnabled([orders.id, progress.id], false);
    await adminSend(request, BASE, "PATCH", "/server", { proxyAll: true });
    expect(await served(request, ORDERS.path), "con Proxy All risponde il backend").toMatchObject({ status: 404, body: { source: "backend" } });

    await runScenario(page, setup);
  });

  test("C: lo stesso setup ripetuto subito, senza ripristino, dà lo stesso risultato", async ({ page, request }) => {
    const setup = await connect(request);
    await runScenario(page, setup);
    await runScenario(page, setup);
  });

  test("due client con la stessa revisione: il secondo salvataggio riceve 409 e il primo resta intatto", async ({ playwright }) => {
    const first = await playwright.request.newContext();
    const second = await playwright.request.newContext();
    try {
      const firstSetup = await connect(first);
      const secondSetup = await connect(second);
      const notes = await firstSetup.findEndpoint(NOTES.method, NOTES.path);
      // Lo stato da cui dipende la verifica del contenuto servito, qualunque cosa abbiano lasciato
      // i casi precedenti.
      await firstSetup.serveMocks();
      await firstSetup.select(notes.id, NOTES.file);
      await firstSetup.setEnabled([notes.id], true);
      const stamp = `${Date.now()}`;

      const readByFirst = await firstSetup.readVariant(notes.id, NOTES.file);
      const readBySecond = await secondSetup.readVariant(notes.id, NOTES.file);
      expect(readBySecond.revision).toBe(readByFirst.revision);

      await firstSetup.writeVariant(notes.id, NOTES.file, { body: { note: `primo-${stamp}` } }, readByFirst.revision);
      const conflict = secondSetup.writeVariant(notes.id, NOTES.file, { body: { note: `secondo-${stamp}` } }, readBySecond.revision);
      await expect(conflict).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { code: "REVISION_CONFLICT", expectedRevision: readBySecond.revision },
      });
      const error = await conflict.catch((reason) => reason);
      expect(error.details.currentRevision).not.toBe(readBySecond.revision);

      // Il contenuto del primo client è quello salvato e servito.
      expect((await firstSetup.readVariant(notes.id, NOTES.file)).response.body).toEqual({ note: `primo-${stamp}` });
      const response = await first.get(`${BASE}${NOTES.path}`);
      expect(await response.json()).toEqual({ note: `primo-${stamp}` });
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  test("dopo un clear del Monitor il vecchio cursore segnala gap cleared, non assenza di traffico", async ({ request }) => {
    const setup = await connect(request);
    const cursor = await setup.monitorCursor();
    await served(request, "/agent-ready");
    await adminSend(request, BASE, "DELETE", "/monitoring/requests", undefined, 204);

    const query = new URLSearchParams({ view: "page", since: cursor.since, runtimeId: cursor.runtimeId, generation: String(cursor.generation) });
    const page = await adminJson(request, BASE, `/monitoring/requests?${query}`);
    expect(page).toMatchObject({ gap: true, gapReason: "cleared" });
    expect(page.cursor.generation).toBeGreaterThan(cursor.generation);

    await expect(setup.readTraffic(cursor)).rejects.toMatchObject({ code: "MONITOR_GAP", details: { gapReason: "cleared" } });
  });

  test("gli errori di setup fermano la prova con un codice, senza mutazioni né attese cieche", async ({ request }) => {
    const infoBefore = await adminJson(request, BASE, "/info");

    const elsewhere = new AgentSetup(request, BASE);
    await expect(elsewhere.connect({ mocksDir: "/workspace/altro" })).rejects.toMatchObject({ code: "WRONG_WORKSPACE" });
    const infoAfter = await adminJson(request, BASE, "/info");
    expect(infoAfter.revisions, "nessuna mutazione dopo il workspace sbagliato").toEqual(infoBefore.revisions);

    // Un contratto servito senza un'operazione usata dal setup (qui PUT /mocks/{id}, la selezione)
    // ferma connect prima di qualunque mutazione. Lo stub risponde con /info reale e lo spec
    // reale privato di quell'operazione, e registra ogni chiamata.
    const realInfo = await adminJson(request, BASE, "/info");
    const spec = YAML.parse(await (await request.get(`${BASE}/_admin/api/openapi.yaml`)).text());
    delete spec.paths["/mocks/{id}"].put;
    const calls = [];
    const stub = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url === "/_admin/api/info") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(realInfo));
      } else if (req.method === "GET" && req.url === "/_admin/api/openapi.yaml") {
        res.writeHead(200, { "content-type": "application/yaml" }).end(YAML.stringify(spec));
      } else {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "unexpected" }));
      }
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    try {
      const incomplete = new AgentSetup(request, `http://127.0.0.1:${stub.address().port}`);
      await expect(incomplete.connect({ mocksDir: MOCKS_DIR })).rejects.toMatchObject({ code: "CONTRACT_UNVERIFIABLE" });
      expect(calls, "solo letture, nessuna mutazione").toEqual(["GET /_admin/api/info", "GET /_admin/api/openapi.yaml"]);
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }

    // Una scrittura rifiutata dal motore porta il suo codice.
    const setup = await connect(request);
    const orders = await setup.findEndpoint(ORDERS.method, ORDERS.path);
    await expect(setup.prepareVariant(orders.id, ORDERS.target, { ...ORDERS_TARGET, status: 42 }, { allowActive: true })).rejects.toMatchObject({
      code: "NOT_APPLIED",
      details: { code: "MUTATION_REJECTED" },
    });

    // Il traffico atteso che non arriva scade entro il limite complessivo.
    const cursor = await setup.monitorCursor();
    const started = Date.now();
    const waiting = setup.readTraffic(cursor, {}, { until: () => false, timeoutMs: 400 });
    await expect(waiting).rejects.toBeInstanceOf(SetupError);
    await expect(waiting).rejects.toMatchObject({ code: "TRAFFIC_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

