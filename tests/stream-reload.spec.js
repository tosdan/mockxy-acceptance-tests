const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");
const { adminJson, adminSend, mockIdFor } = require("./admin-client");

// Continuità degli stream e diagnostica durante i reload (piano agent/API, §13 C2 e C3), su
// rete e filesystem reali: browser → istanza di sviluppo mockxy-stream, con watcher e admin.
// I file si modificano nel tmpfs del container con `docker compose exec`, come un editor che
// salva; le mutazioni API scrivono nello stesso tmpfs. Nessun file versionato cambia.

const BASE = stack.mockxyStreamBaseUrl;
const COMPOSE_DIR = path.join(__dirname, "..");
const SEED_DIR = path.join(COMPOSE_DIR, "workspace-stream", "mocks");
const SERVICE = "mockxy-stream";

// Il watcher emette un evento dopo 100 ms di stabilità del file (awaitWriteFinish del motore):
// un runtime senza nuovi tentativi per un intervallo ampiamente superiore non ha eventi in coda.
// Serve solo a preparare e ripulire lo stato, mai come barriera delle asserzioni.
const QUIET_MS = 700;
const SETTLE_TIMEOUT_MS = 20000;
const EFFECT_TIMEOUT_MS = 15000;

const SSE_SEED_MESSAGES = ["sse-uno", "sse-due"];
const WS_SEED_MESSAGES = ["ws-uno", "ws-due"];

function readSeed(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, relativePath), "utf8"));
}

/** Esegue uno script shell nel container; lo stdin opzionale arriva allo script. */
function execInStream(script, input) {
  return execFileSync("docker", ["compose", "exec", "-T", SERVICE, "sh", "-c", script], {
    cwd: COMPOSE_DIR,
    input,
    encoding: "utf8",
  });
}

/** Scrive un file del workspace osservato, relativo alla cartella dei mock del container. */
function writeWorkspaceFile(relativePath, content) {
  execInStream(`cat > "/workspace/mocks/${relativePath}"`, content);
}

/** Riporta il workspace al seed: ricopia i file e toglie quelli aggiunti dai test. */
function restoreSeedFiles() {
  execInStream(
    'cp -R /seed/. /workspace/mocks/ && cd /workspace/mocks && find . -type f | while read -r file; do [ -e "/seed/$file" ] || rm -f "$file"; done'
  );
}

async function runtimeStatus(request) {
  return adminJson(request, BASE, "/runtime/status");
}

async function pollUntil(check, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.done) {
      return last.value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: non raggiunto entro ${timeoutMs} ms. Ultimo stato: ${JSON.stringify(last?.value)}`);
}

/**
 * Attende il tentativo di caricamento che rende osservabile una modifica: `effect` guarda
 * l'effetto atteso (errore in diagnostica, risposta servita cambiata), non un numero di reload,
 * perché API e watcher possono aggregare le cause in un solo tentativo.
 */
async function waitForAttempt(request, afterAttemptId, effect, description) {
  return pollUntil(
    async () => {
      const status = await runtimeStatus(request);
      const reached = status.lastAttempt.id > afterAttemptId && (await effect(status));
      return { done: reached, value: status };
    },
    description,
    EFFECT_TIMEOUT_MS
  );
}

async function servedJson(request, routePath) {
  const response = await request.get(`${BASE}${routePath}`);
  return response.ok() ? response.json() : { status: response.status() };
}

async function streamConnections(request, ids) {
  const [sse, ws] = await Promise.all([
    adminJson(request, BASE, `/mocks/${ids.sse}/sse/connections`),
    adminJson(request, BASE, `/mocks/${ids.ws}/ws/connections`),
  ]);
  return { sse: sse.connections, ws: ws.connections };
}

/** Il seed è installato, servito e stabile: nessun errore, nessun tentativo in arrivo. */
async function settleOnSeed(request, ids) {
  const seedServed = async () => {
    const [sseDetail, wsDetail, other, handler] = await Promise.all([
      adminJson(request, BASE, `/mocks/${ids.sse}`),
      adminJson(request, BASE, `/mocks/${ids.ws}`),
      servedJson(request, "/stream-other"),
      servedJson(request, "/stream-handler"),
    ]);
    return (
      JSON.stringify(sseDetail.endpoint) === JSON.stringify(readSeed("stream-sse/GET.endpoint.json")) &&
      JSON.stringify(wsDetail.endpoint) === JSON.stringify(readSeed("stream-ws/GET.endpoint.json")) &&
      JSON.stringify(sseDetail.response.script) ===
        JSON.stringify(readSeed("stream-sse/GET.responses/001.response.json").script) &&
      JSON.stringify(wsDetail.response.script) ===
        JSON.stringify(readSeed("stream-ws/GET.responses/001.response.json").script) &&
      other.version === 1 &&
      handler.version === 1
    );
  };
  let lastAttemptId = null;
  let quietSince = Date.now();
  await pollUntil(
    async () => {
      const status = await runtimeStatus(request);
      if (status.lastAttempt.id !== lastAttemptId) {
        lastAttemptId = status.lastAttempt.id;
        quietSince = Date.now();
      }
      const healthy = status.lastAttempt.status === "applied" && status.errors.length === 0;
      const quiet = Date.now() - quietSince >= QUIET_MS;
      const connections = await streamConnections(request, ids);
      const closed = connections.sse.length === 0 && connections.ws.length === 0;
      return { done: healthy && quiet && closed && (await seedServed()), value: { status, connections } };
    },
    "workspace del seed installato e stabile, senza connessioni aperte",
    SETTLE_TIMEOUT_MS
  );
}

/**
 * Apre dal browser la SSE e la WS e attende che la console le registri e che entrambi i
 * copioni siano consegnati: da qui in poi un messaggio del copione in più indica un riavvio.
 */
async function openStreams(page, request, ids) {
  const [sseOpened, wsOpened] = await Promise.all([
    page.evaluate((url) => window.sseOpen("sse", url), `${BASE}/stream-sse`),
    page.evaluate((url) => window.wsOpen("ws", url), `${BASE.replace("http", "ws")}/stream-ws`),
  ]);
  expect(sseOpened.opened, "apertura della SSE").toBe(true);
  expect(wsOpened.opened, "apertura della WS").toBe(true);

  await expect
    .poll(async () => ({
      sse: (await page.evaluate(() => window.sseState("sse"))).messages,
      ws: (await page.evaluate(() => window.wsState("ws"))).received,
    }))
    .toEqual({ sse: SSE_SEED_MESSAGES, ws: WS_SEED_MESSAGES });

  const connections = await streamConnections(request, ids);
  expect(connections.sse, "connessioni SSE in console").toHaveLength(1);
  expect(connections.ws, "connessioni WS in console").toHaveLength(1);
  return { sse: connections.sse[0], ws: connections.ws[0] };
}

async function pageStreams(page) {
  return page.evaluate(() => ({ sse: window.sseState("sse"), ws: window.wsState("ws") }));
}

/** La SSE originale è ancora quella: stessa connessione, nessuna riconnessione nascosta. */
async function expectSsePreserved(page, request, ids, original) {
  const connections = await streamConnections(request, ids);
  expect(connections.sse.map((connection) => connection.id), "stessa connessione SSE in console").toEqual([
    original.id,
  ]);
  expect(connections.sse[0].scriptIndex, "copione SSE non ripartito").toBe(original.scriptIndex);
  const { sse } = await pageStreams(page);
  expect(sse, "EventSource senza errori né nuove aperture").toMatchObject({
    opens: 1,
    errors: 0,
    messages: SSE_SEED_MESSAGES,
    readyState: 1,
  });

  // La connessione è viva, non solo silenziosa: un push della console la raggiunge.
  const push = await adminSend(request, BASE, "POST", `/mocks/${ids.sse}/sse/push`, { data: "sse-push" });
  expect(push.delivered).toBe(1);
  await expect.poll(async () => (await pageStreams(page)).sse.messages).toEqual([...SSE_SEED_MESSAGES, "sse-push"]);
  expect((await pageStreams(page)).sse.opens).toBe(1);
}

/** La WS originale è ancora quella: stessa connessione, mai chiusa. */
async function expectWsPreserved(page, request, ids, original) {
  const connections = await streamConnections(request, ids);
  expect(connections.ws.map((connection) => connection.id), "stessa connessione WS in console").toEqual([
    original.id,
  ]);
  expect(connections.ws[0].scriptIndex, "copione WS non ripartito").toBe(original.scriptIndex);
  const { ws } = await pageStreams(page);
  expect(ws, "WebSocket mai chiusa e copione non ripetuto").toEqual({ received: WS_SEED_MESSAGES, closed: null });

  const push = await adminSend(request, BASE, "POST", `/mocks/${ids.ws}/ws/push`, { data: "ws-push" });
  expect(push.delivered).toBe(1);
  await expect.poll(async () => (await pageStreams(page)).ws.received).toEqual([...WS_SEED_MESSAGES, "ws-push"]);
}

test.describe("stream e diagnostica durante i reload", () => {
  // L'istanza, i suoi file e le connessioni della console sono stato condiviso: una sola
  // esecuzione (Chromium), in ordine in un solo worker. Modalità "default" e non "serial": ogni
  // test riparte dal seed, quindi un fallimento non deve saltare i successivi. Le semantiche
  // degli stream nel browser sono già coperte sui tre motori da sse-mock.spec.js e ws-mock.spec.js.
  test.describe.configure({ mode: "default" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stato condiviso dell'istanza mockxy-stream: una sola esecuzione, in serie"
  );

  let ids;

  test.beforeAll(async ({ request }) => {
    const info = await adminJson(request, BASE, "/info");
    expect(info.watcher, "watcher pronto prima delle prove").toMatchObject({ state: "ready", lastError: null });
    ids = {
      sse: await mockIdFor(request, BASE, "GET", "/stream-sse"),
      ws: await mockIdFor(request, BASE, "GET", "/stream-ws"),
      other: await mockIdFor(request, BASE, "GET", "/stream-other"),
      handler: await mockIdFor(request, BASE, "GET", "/stream-handler"),
    };
  });

  test.beforeEach(async ({ page, request }) => {
    restoreSeedFiles();
    await settleOnSeed(request, ids);
    await page.goto("/");
  });

  // Anche dopo un fallimento: prima si chiudono le connessioni del browser, poi si ripristinano
  // i file e si attende il seed stabile, così il test successivo (o un retry) parte pulito.
  test.afterEach(async ({ page, request }) => {
    await page
      .evaluate(() => {
        window.sseCloseAll();
        window.wsCloseAll();
      })
      .catch(() => {});
    restoreSeedFiles();
    await settleOnSeed(request, ids);
  });

  test("descrizione, variante inattiva ed endpoint estraneo cambiati via API non toccano gli stream aperti", async ({ page, request }) => {
    const original = await openStreams(page, request, ids);
    const before = await runtimeStatus(request);

    await adminSend(request, BASE, "PUT", `/mocks/${ids.sse}/endpoint`, { description: "Descrizione cambiata" });
    await adminSend(request, BASE, "PUT", `/mocks/${ids.ws}/endpoint`, { description: "Descrizione cambiata" });

    // Varianti realmente inattive sugli stessi endpoint: preparate, non selezionate.
    const sseDraft = await adminSend(request, BASE, "POST", `/mocks/${ids.sse}/responses`, {
      select: false,
      type: "sse",
      title: "Bozza",
      script: [{ afterMs: 0, data: "sse-bozza" }],
      onEnd: "keep-open",
    }, 201);
    const wsDraft = await adminSend(request, BASE, "POST", `/mocks/${ids.ws}/responses`, {
      select: false,
      type: "ws",
      title: "Bozza",
      script: [{ afterMs: 0, data: "ws-bozza" }],
      onEnd: "keep-open",
    }, 201);
    for (const [id, draft] of [[ids.sse, sseDraft], [ids.ws, wsDraft]]) {
      const variant = await adminJson(request, BASE, `/mocks/${id}/responses/${draft.createdResponseFile}`);
      expect(variant, "la variante preparata non è attiva").toMatchObject({ selected: false, active: false });
    }

    await adminSend(request, BASE, "PUT", `/mocks/${ids.other}/responses/001.response.json`, { body: { version: 2 } });
    expect(await servedJson(request, "/stream-other"), "la modifica estranea è servita").toEqual({ version: 2 });

    const after = await runtimeStatus(request);
    expect(after.lastAttempt.id, "le mutazioni hanno ricaricato il runtime").toBeGreaterThan(before.lastAttempt.id);
    expect(after.lastAttempt.reasons).toContain("admin");

    await expectSsePreserved(page, request, ids, original.sse);
    await expectWsPreserved(page, request, ids, original.ws);
  });

  test("una modifica estranea sul filesystem e il reload del watcher non interrompono gli stream", async ({ page, request }) => {
    const original = await openStreams(page, request, ids);
    const before = await runtimeStatus(request);

    const otherSeed = readSeed("stream-other/GET.responses/001.response.json");
    writeWorkspaceFile(
      "stream-other/GET.responses/001.response.json",
      JSON.stringify({ ...otherSeed, body: { version: 3 } }, null, 2)
    );
    const status = await waitForAttempt(
      request,
      before.lastAttempt.id,
      async () => (await servedJson(request, "/stream-other")).version === 3,
      "reload del watcher con la modifica estranea"
    );
    expect(status.lastAttempt.reasons).toContain("watcher");
    expect(status.lastAttempt.status).toBe("applied");

    await expectSsePreserved(page, request, ids, original.sse);
    await expectWsPreserved(page, request, ids, original.ws);
  });

  test("cambiare il copione SSE attivo chiude solo la SSE originale; la WS resta aperta", async ({ page, request }) => {
    const original = await openStreams(page, request, ids);

    await adminSend(request, BASE, "PUT", `/mocks/${ids.sse}/responses/001.response.json`, {
      script: [{ afterMs: 0, data: "sse-nuovo" }],
    });

    // La connessione originale sparisce dalla console; EventSource se ne accorge (errore) e
    // riconnette, ricevendo il copione nuovo su una connessione nuova.
    await expect
      .poll(async () => (await streamConnections(request, ids)).sse.map((connection) => connection.id))
      .not.toContain(original.sse.id);
    await expect.poll(async () => (await pageStreams(page)).sse.messages).toContain("sse-nuovo");
    const { sse } = await pageStreams(page);
    expect(sse.errors, "EventSource ha visto la chiusura").toBeGreaterThanOrEqual(1);
    expect(sse.opens, "EventSource ha riaperto una connessione nuova").toBe(2);
    expect(sse.messages).toEqual([...SSE_SEED_MESSAGES, "sse-nuovo"]);

    await expectWsPreserved(page, request, ids, original.ws);
  });

  test("cambiare il copione WS attivo chiude solo la WS originale; la SSE resta aperta", async ({ page, request }) => {
    const original = await openStreams(page, request, ids);

    await adminSend(request, BASE, "PUT", `/mocks/${ids.ws}/responses/001.response.json`, {
      script: [{ afterMs: 0, data: "ws-nuovo" }],
    });

    await expect.poll(async () => (await pageStreams(page)).ws.closed).not.toBeNull();
    expect((await pageStreams(page)).ws.received, "nessun messaggio dopo la chiusura").toEqual(WS_SEED_MESSAGES);
    await expect
      .poll(async () => (await streamConnections(request, ids)).ws.map((connection) => connection.id))
      .not.toContain(original.ws.id);

    // Una connessione nuova riceve il copione nuovo.
    const fresh = await page.evaluate((url) => window.wsCollect(url, 1), `${BASE.replace("http", "ws")}/stream-ws`);
    expect(fresh.messages.map((message) => message.data)).toEqual(["ws-nuovo"]);

    await expectSsePreserved(page, request, ids, original.sse);
  });

  test("una nuova definizione SSE selezionata ma illeggibile lascia servito lo stream precedente", async ({ page, request }) => {
    const original = await openStreams(page, request, ids);
    const before = await runtimeStatus(request);

    // Sul filesystem, come un editor: una variante nuova con JSON non interpretabile, poi la
    // sua selezione nella definizione dell'endpoint.
    writeWorkspaceFile("stream-sse/GET.responses/002.response.json", '{ "type": "sse", "script": [ ');
    const endpointSeed = readSeed("stream-sse/GET.endpoint.json");
    writeWorkspaceFile(
      "stream-sse/GET.endpoint.json",
      JSON.stringify(
        { ...endpointSeed, responseFiles: ["001.response.json", "002.response.json"], selectedResponseFile: "002.response.json" },
        null,
        2
      )
    );

    const findError = (status) => status.errors.find((error) => error.endpointId === ids.sse);
    const status = await waitForAttempt(
      request,
      before.lastAttempt.id,
      async (current) => findError(current) != null,
      "errore di caricamento della nuova definizione SSE"
    );
    expect(status.lastAttempt).toMatchObject({ status: "degraded" });
    expect(status.lastAttempt.reasons).toContain("watcher");
    expect(findError(status)).toMatchObject({ filePath: "stream-sse/GET.endpoint.json", serving: "retained" });

    // Lo stream servito resta il precedente: la connessione continua, console e push funzionano.
    await expectSsePreserved(page, request, ids, original.sse);
    await expectWsPreserved(page, request, ids, original.ws);

    // Anche una connessione nuova riceve il copione mantenuto, non quello selezionato sul disco.
    const fresh = await page.evaluate((url) => window.sseCollect(url, 2), `${BASE}/stream-sse`);
    expect(fresh.events.map((event) => event.data)).toEqual(SSE_SEED_MESSAGES);
  });

  test("un handler dal sorgente rotto resta servito col precedente, e la correzione rimuove l'errore", async ({ page, request }) => {
    const handlerUrl = `${BASE}/stream-handler`;
    const served = () => page.evaluate((url) => window.callApi(url), handlerUrl);
    expect((await served()).body).toEqual({ version: 1 });

    const before = await runtimeStatus(request);
    const diagnosticsBefore = (await adminJson(request, BASE, "/info")).revisions.diagnostics;
    const handlerFile = "stream-handler/GET.responses/001.handler.js";
    const seedSource = fs.readFileSync(path.join(SEED_DIR, handlerFile), "utf8");

    writeWorkspaceFile(handlerFile, "module.exports = {\n");
    const findError = (status) => status.errors.find((error) => error.endpointId === ids.handler);
    const broken = await waitForAttempt(
      request,
      before.lastAttempt.id,
      async (current) => findError(current) != null,
      "errore di caricamento dell'handler"
    );
    expect(broken.lastAttempt).toMatchObject({ status: "degraded" });
    expect(broken.lastAttempt.reasons).toContain("watcher");
    expect(findError(broken)).toMatchObject({ serving: "retained" });
    expect(findError(broken).message).toContain("001.handler.js");
    const diagnosticsBroken = (await adminJson(request, BASE, "/info")).revisions.diagnostics;
    expect(diagnosticsBroken, "la revisione diagnostics segnala l'errore").toBeGreaterThan(diagnosticsBefore);
    expect((await served()).body, "il browser riceve ancora la risposta precedente").toEqual({ version: 1 });

    writeWorkspaceFile(handlerFile, seedSource.replace("version: 1", "version: 2"));
    const fixed = await waitForAttempt(
      request,
      broken.lastAttempt.id,
      async (current) => current.errors.length === 0,
      "correzione dell'handler"
    );
    expect(fixed.lastAttempt).toMatchObject({ status: "applied" });
    expect(fixed.lastAttempt.reasons).toContain("watcher");
    expect((await served()).body, "il browser riceve la risposta nuova").toEqual({ version: 2 });
    const diagnosticsFixed = (await adminJson(request, BASE, "/info")).revisions.diagnostics;
    expect(diagnosticsFixed, "la revisione diagnostics segnala la correzione").toBeGreaterThan(diagnosticsBroken);
  });
});
