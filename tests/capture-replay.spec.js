const http = require("http");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");
const { adminJson } = require("./admin-client");
const { AgentSetup, requireWritten } = require("./agent-setup");

// Cattura e riproduzione del traffico (piano agent/API, §13 C7) nell'immagine distribuita: una
// risposta reale del backend, generata dal browser, diventa un mock preparato senza attivazione
// implicita; il replay si verifica dal browser e dal contatore del backend.

const BASE = stack.mockxyCaptureBaseUrl;
const MOCKS_DIR = "/workspace/mocks";
const DECLARED_CONFIG = { corsEnabled: true, globalDelayMs: 0, delayAllRequests: false };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Preparazione senza effetti su ciò che è servito: endpoint nuovi spenti, varianti non selezionate.
const PREPARE = { selectAddedVariants: false, newEndpointEnabled: false };

let sequence = 0;
// Path usati dal test in corso: la pulizia rimuove ogni endpoint creato su di essi, anche quando
// il test fallisce prima di conoscerne l'id.
let usedPaths = [];
/** Path unico per test e tentativo: nessun residuo di un'esecuzione precedente lo condivide. */
function uniquePath(prefix) {
  sequence += 1;
  const routePath = `${prefix}/${Date.now()}-${sequence}`;
  usedPaths.push(routePath);
  return routePath;
}

async function arrivals(request, routePath) {
  const response = await request.get(`${stack.backendDirectBaseUrl}/api/arrivals?path=${encodeURIComponent(routePath)}`);
  return (await response.json()).count;
}

function callFromBrowser(page, url) {
  return page.evaluate((target) => window.callApi(target), url);
}

/**
 * Esegue l'azione del browser e trova la sua cattura nel Monitor: cursore e lettura con gli stessi
 * filtri, gap che ferma la verifica. Restituisce la voce di riepilogo e il runtimeId del cursore.
 */
async function captureFromBrowser(setup, routePath, action) {
  const filters = { method: "GET", path: routePath };
  const cursor = await setup.monitorCursor(filters);
  const result = await action();
  const traffic = await setup.readTraffic(cursor, filters, { until: (items) => items.length >= 1 });
  expect(traffic.items, `una sola cattura di GET ${routePath}`).toHaveLength(1);
  return { result, entry: traffic.items[0], runtimeId: cursor.runtimeId };
}

/**
 * Proxy di test fra l'helper e mockxy-capture: inoltra ogni richiesta al motore reale; per
 * create-mocks attende la risposta completa del motore (la creazione è avvenuta) e poi chiude la
 * connessione verso il client senza consegnarla. Conta le richieste di creazione ricevute.
 */
async function startLosingProxy() {
  const target = new URL(BASE);
  let createRequests = 0;
  const lostResponses = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const isCreate = req.method === "POST" && req.url.startsWith("/_admin/api/monitoring/requests/create-mocks");
      if (isCreate) {
        createRequests += 1;
      }
      const upstream = http.request(
        { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } },
        (upstreamResponse) => {
          if (!isCreate) {
            res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
            upstreamResponse.pipe(res);
            return;
          }
          const body = [];
          upstreamResponse.on("data", (chunk) => body.push(chunk));
          upstreamResponse.on("end", () => {
            lostResponses.push({ status: upstreamResponse.statusCode, body: JSON.parse(Buffer.concat(body).toString("utf8")) });
            req.socket.destroy();
          });
        }
      );
      upstream.on("error", () => req.socket.destroy());
      upstream.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    createRequests: () => createRequests,
    lostResponses: () => lostResponses,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test.describe("cattura e riproduzione del traffico", () => {
  // Catalogo e Monitor dell'istanza sono stato condiviso: una sola esecuzione (Chromium), in
  // ordine in un solo worker. Ogni test usa path propri e rimuove gli endpoint che ha creato.
  test.describe.configure({ mode: "default" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stato condiviso dell'istanza mockxy-capture: una sola esecuzione, in ordine"
  );

  let setup;

  test.beforeEach(async ({ page, request }) => {
    usedPaths = [];
    setup = new AgentSetup(request, BASE);
    await setup.connect({ mocksDir: MOCKS_DIR });
    await setup.declareConfig(DECLARED_CONFIG);
    await setup.serveMocks();
    await page.goto("/");
  });

  // Anche dopo un fallimento: gli endpoint creati sui path del test spariscono dal catalogo.
  test.afterEach(async ({ request }) => {
    const { items } = await adminJson(request, BASE, "/mocks");
    for (const item of items.filter((candidate) => usedPaths.includes(candidate.path))) {
      const response = await request.delete(`${BASE}/_admin/api/mocks/${item.id}`);
      expect([204, 404], `rimozione di ${item.method} ${item.path}`).toContain(response.status());
    }
  });

  test("una risposta reale del backend diventa un mock preparato, spento finché non lo si attiva", async ({ page, request }) => {
    const routePath = uniquePath("/capture/receipt");
    const url = `${BASE}${routePath}`;

    const { result, entry, runtimeId } = await captureFromBrowser(setup, routePath, () => callFromBrowser(page, url));
    expect(result).toMatchObject({ blocked: false, status: 202, body: { receipt: "r-1" }, headers: { "x-receipt-id": "r-1", "x-mock-source": "backend" } });

    // La voce completa, per ID e runtimeId: status, header e body del backend.
    const full = await setup.readMonitorEntry(entry.id, runtimeId);
    expect(full).toMatchObject({ id: entry.id, method: "GET", path: routePath, status: 202, source: "backend" });
    expect(full.responseHeaders["x-receipt-id"]).toBe("r-1");
    expect(JSON.parse(full.responseBody)).toEqual({ source: "backend", receipt: "r-1" });

    const outcome = await setup.createMocksFromMonitor(runtimeId, [entry.id], { onConflict: "skip", ...PREPARE });
    const [item] = requireWritten(outcome);
    expect(item).toMatchObject({
      requestId: entry.id,
      method: "GET",
      path: routePath,
      writeOutcome: "created",
      responseFile: "001.response.json",
      runtimeOutcome: "not_applicable",
      captureOutcome: "complete",
      warnings: [],
      error: null,
    });

    // Il mock scritto è la cattura: status, body e header significativi, senza header di trasporto.
    const variant = await setup.readVariant(item.id, item.responseFile);
    expect(variant.response).toMatchObject({ type: "mock", status: 202, delayMs: 0, body: { source: "backend", receipt: "r-1" } });
    expect(variant.response.headers["x-receipt-id"]).toBe("r-1");
    for (const transport of ["date", "content-length", "transfer-encoding", "connection"]) {
      expect(Object.keys(variant.response.headers)).not.toContain(transport);
    }
    // Neanche l'header tecnico con cui Mockxy dichiara chi ha risposto: catturato valeva
    // "backend", e quello del mock lo imposta il serving (mockxy#42).
    expect(full.responseHeaders["x-mock-source"], "la cattura lo contiene").toBe("backend");
    expect(Object.keys(variant.response.headers).map((name) => name.toLowerCase())).not.toContain("x-mock-source");
    expect((await setup.read(`/mocks/${item.id}`, "Reading the endpoint")).endpoint.enabled).toBe(false);

    // Prima dell'attivazione il browser riceve ancora il backend.
    const beforeActivation = await callFromBrowser(page, url);
    expect(beforeActivation).toMatchObject({ status: 202, body: { receipt: "r-2" }, headers: { "x-mock-source": "backend" } });
    expect(await arrivals(request, routePath)).toBe(2);

    // Attivazione esplicita: risponde il mock, e il backend non viene più chiamato.
    await setup.setEnabled([item.id], true);
    const replayed = await callFromBrowser(page, url);
    expect(replayed).toMatchObject({
      blocked: false,
      status: 202,
      body: { source: "backend", receipt: "r-1" },
      headers: { "x-receipt-id": "r-1", "x-mock-source": "mock" },
    });
    expect(await arrivals(request, routePath), "il backend non riceve la richiesta servita dal mock").toBe(2);
  });

  test("add-variant su un endpoint esistente prepara una variante identificabile senza cambiare il comportamento attivo", async ({ page, request }) => {
    const routePath = uniquePath("/capture/receipt");
    const url = `${BASE}${routePath}`;

    const first = await captureFromBrowser(setup, routePath, () => callFromBrowser(page, url));
    const [endpoint] = requireWritten(await setup.createMocksFromMonitor(first.runtimeId, [first.entry.id], { onConflict: "skip", ...PREPARE }));
    // Seconda risposta del backend, catturata mentre l'endpoint è ancora spento.
    const second = await captureFromBrowser(setup, routePath, () => callFromBrowser(page, url));
    expect(second.result.body).toMatchObject({ receipt: "r-2" });
    await setup.setEnabled([endpoint.id], true);
    expect((await callFromBrowser(page, url)).body).toMatchObject({ receipt: "r-1" });

    const outcome = await setup.createMocksFromMonitor(second.runtimeId, [second.entry.id], { onConflict: "add-variant", ...PREPARE });
    const [added] = requireWritten(outcome);
    expect(added).toMatchObject({ id: endpoint.id, writeOutcome: "variant_added", captureOutcome: "complete", runtimeOutcome: "not_applicable" });
    expect(added.responseFile).not.toBe(endpoint.responseFile);

    // La variante aggiunta si riconosce per filename, titolo e contenuto, ed è inattiva.
    const variant = await setup.readVariant(endpoint.id, added.responseFile);
    expect(variant).toMatchObject({ selected: false, active: false, response: { status: 202, body: { receipt: "r-2" } } });
    expect(variant.response.title).toMatch(/^monitor · \d{2}:\d{2}:\d{2}$/);
    expect((await setup.read(`/mocks/${endpoint.id}`, "Reading the endpoint")).selectedResponseFile).toBe(endpoint.responseFile);

    // Il comportamento attivo resta quello di prima, fino all'attivazione esplicita.
    expect((await callFromBrowser(page, url)).body).toMatchObject({ receipt: "r-1" });
    await setup.select(endpoint.id, added.responseFile);
    expect(await callFromBrowser(page, url)).toMatchObject({ status: 202, body: { receipt: "r-2" }, headers: { "x-receipt-id": "r-2", "x-mock-source": "mock" } });
    expect(await arrivals(request, routePath), "le risposte del mock non chiamano il backend").toBe(2);
  });

  test("una cattura binaria diventa una bozza incompleta e non attiva, non un replay fedele", async ({ page, request }) => {
    const routePath = uniquePath("/capture/binary");
    const url = `${BASE}${routePath}`;
    const fetchBinary = () => page.evaluate((target) => window.fetchBinary(target), url);

    const { result, entry, runtimeId } = await captureFromBrowser(setup, routePath, fetchBinary);
    expect(result).toMatchObject({ blocked: false, status: 200, firstBytes: PNG_SIGNATURE });
    expect((await setup.readMonitorEntry(entry.id, runtimeId)).responseBody).toMatch(/^\[binary payload: /);

    const outcome = await setup.createMocksFromMonitor(runtimeId, [entry.id], { onConflict: "skip", ...PREPARE });
    const [item] = requireWritten(outcome);
    expect(outcome.counts).toMatchObject({ created: 1, incomplete: 1 });
    expect(item).toMatchObject({
      writeOutcome: "created",
      captureOutcome: "incomplete",
      warnings: [{ code: "INCOMPLETE_CAPTURE", reason: "binary" }],
    });

    // La bozza lo dichiara e resta spenta: il browser continua a ricevere il backend.
    const detail = await setup.read(`/mocks/${item.id}`, "Reading the endpoint");
    expect(detail.endpoint.enabled).toBe(false);
    expect(detail.endpoint.description).toMatch(/^\[da completare\]/);
    expect((await setup.readVariant(item.id, item.responseFile)).response.body).toEqual({});
    expect(await fetchBinary()).toMatchObject({ status: 200, firstBytes: PNG_SIGNATURE });
    expect(await arrivals(request, routePath)).toBe(2);
  });

  test("una risposta persa dopo la creazione ferma il setup senza ripeterla e con i dati per ispezionare il catalogo", async ({ page, request }) => {
    const routePath = uniquePath("/capture/receipt");
    const { entry, runtimeId } = await captureFromBrowser(setup, routePath, () => callFromBrowser(page, `${BASE}${routePath}`));

    const proxy = await startLosingProxy();
    try {
      // add-variant rende visibile una ripetizione: una seconda richiesta aggiungerebbe una variante.
      const viaProxy = new AgentSetup(request, proxy.baseUrl);
      await viaProxy.connect({ mocksDir: MOCKS_DIR });
      const lost = viaProxy.createMocksFromMonitor(runtimeId, [entry.id], { onConflict: "add-variant", ...PREPARE });
      await expect(lost).rejects.toMatchObject({ code: "CREATE_OUTCOME_UNKNOWN", details: { runtimeId, ids: [entry.id] } });

      // Una sola richiesta, e il motore l'aveva completata: la risposta persa era un 201.
      expect(proxy.createRequests(), "una sola richiesta di creazione, nessuna ripetizione").toBe(1);
      expect(proxy.lostResponses()).toEqual([expect.objectContaining({ status: 201 })]);
      expect(proxy.lostResponses()[0].body.items).toEqual([expect.objectContaining({ requestId: entry.id, writeOutcome: "created" })]);
    } finally {
      await proxy.close();
    }

    // Il catalogo mostra esattamente ciò che è stato creato, una volta sola.
    const matches = (await adminJson(request, BASE, "/mocks")).items.filter((item) => item.method === "GET" && item.path === routePath);
    expect(matches, "un solo endpoint creato").toHaveLength(1);
    expect(matches[0].responseCount, "una sola variante: la creazione non è stata ripetuta").toBe(1);
  });
});
