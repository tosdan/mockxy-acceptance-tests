const crypto = require("crypto");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");
const {
  adminJson,
  adminUrl,
  fetchServedSpec,
  schemaValidator,
  resolveRef,
  requestBodyProperties,
} = require("./admin-client");

// Discovery e accesso amministrativo nell'immagine standalone distribuita (piano agent/API,
// §13 C2 e C8). L'istanza mockxy-discovery è di sola lettura per questi test: nessuno la
// modifica, quindi overrides vuoti e un solo tentativo di caricamento sono asserzioni stabili.

// Specchio delle nove impostazioni dichiarate per mockxy-discovery in docker-compose.yml:
// alcune diverse dai default, così un motore che ignorasse la fixture non passerebbe.
const DISCOVERY_FIXTURE_CONFIG = {
  backendUrl: "http://backend:9000",
  proxyFallbackEnabled: true,
  corsEnabled: true,
  delayAllRequests: false,
  caseInsensitiveFilters: false,
  adaptProxyCookies: true,
  rewriteProxyRedirects: false,
  globalDelayMs: 25,
  requestTimeoutMs: 4321,
};

// Punti di mount del workspace nell'immagine standalone (Dockerfile.standalone).
const CONTAINER_MOCKS_DIR = "/workspace/mocks";
const CONTAINER_FILES_DIR = "/workspace/files";

// Le rotte di discovery: le stesse quattro per le prove di accesso.
const DISCOVERY_ROUTES = ["/info", "/config", "/runtime/status", "/openapi.yaml"];

// Operazioni dell'admin API su cui si appoggiano gli scenari agent/API della suite (T1–T5):
// lo spec servito deve dichiararle con questo metodo e questo operationId.
const OPERATIONS_USED = [
  ["get", "/info", "getRuntimeInfo"],
  ["get", "/config", "getRuntimeConfig"],
  ["patch", "/config", "patchRuntimeConfig"],
  ["get", "/runtime/status", "getRuntimeStatus"],
  ["get", "/openapi.yaml", "getAdminOpenapi"],
  ["get", "/mocks", "listMocks"],
  ["get", "/mocks/{id}", "getMock"],
  ["put", "/mocks/{id}", "updateMock"],
  ["put", "/mocks/{id}/endpoint", "updateEndpointMetadata"],
  ["patch", "/mocks/enabled", "setEndpointsEnabled"],
  ["post", "/mocks/{id}/responses", "createResponse"],
  ["get", "/mocks/{id}/responses/{responseFileName}", "getResponse"],
  ["put", "/mocks/{id}/responses/{responseFileName}", "updateResponse"],
  ["get", "/mocks/{id}/sequence/state", "getSequenceState"],
  ["post", "/mocks/{id}/sequence/reset", "resetSequence"],
  ["get", "/mocks/{id}/sse/connections", "listSseState"],
  ["get", "/mocks/{id}/ws/connections", "listWsState"],
  ["get", "/server", "getServerState"],
  ["patch", "/server", "setServerState"],
  ["get", "/monitoring/requests", "listMonitorEntries"],
  ["delete", "/monitoring/requests", "clearMonitorEntries"],
  ["get", "/monitoring/requests/{id}", "getMonitorEntry"],
  ["post", "/monitoring/requests/create-mocks", "createMocksFromMonitor"],
];

function engineCheckoutVersion() {
  // Il compose costruisce l'immagine da ../mockxy: la versione attesa è quella del checkout
  // costruito, non un numero fisso (la suite segue il ref corrente del motore).
  return require(path.join(__dirname, "..", "..", "mockxy", "package.json")).version;
}

function expectValid(validate, value, label) {
  const { valid, errors } = validate(value);
  expect(valid, `${label} non rispetta lo schema dello spec servito: ${JSON.stringify(errors)}`).toBe(true);
}

test.describe("discovery nell'immagine distribuita", () => {
  // Letture HTTP amministrative, senza semantica browser: una sola esecuzione basta.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "solo client HTTP: il motore del browser non cambia l'esito"
  );

  test("lo spec servito dal container dichiara le operazioni e i campi usati dagli scenari", async ({ request }) => {
    const spec = await fetchServedSpec(request, stack.mockxyDiscoveryBaseUrl);

    expect(spec.openapi).toMatch(/^3\.1\./);
    for (const [method, route, operationId] of OPERATIONS_USED) {
      expect(spec.paths?.[route]?.[method]?.operationId, `${method.toUpperCase()} ${route}`).toBe(operationId);
    }

    // I campi da cui dipendono i passi successivi: cursore del Monitor, preparazione inattiva,
    // override effimeri e trasformazione del traffico catturato.
    const monitorParams = spec.paths["/monitoring/requests"].get.parameters.map(
      (parameter) => resolveRef(spec, parameter).name
    );
    expect(monitorParams).toEqual(
      expect.arrayContaining(["view", "since", "runtimeId", "generation", "method", "path"])
    );
    expect(requestBodyProperties(spec, spec.paths["/mocks/{id}/responses"].post)).toContain("select");
    expect(requestBodyProperties(spec, spec.paths["/config"].patch)).toEqual(
      expect.arrayContaining(["set", "unset"])
    );
    expect(requestBodyProperties(spec, spec.paths["/monitoring/requests/create-mocks"].post)).toEqual(
      expect.arrayContaining(["runtimeId", "ids", "onConflict", "selectAddedVariants", "newEndpointEnabled"])
    );
  });

  test("/info, /config e /runtime/status rispettano lo spec e descrivono lo stesso runtime", async ({ request }) => {
    const spec = await fetchServedSpec(request, stack.mockxyDiscoveryBaseUrl);
    const info = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/info");
    const config = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/config");
    const status = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/runtime/status");

    expectValid(schemaValidator(spec, "RuntimeInfo"), info, "/info");
    expectValid(schemaValidator(spec, "RuntimeConfigState"), config, "/config");
    expectValid(schemaValidator(spec, "RuntimeStatus"), status, "/runtime/status");

    expect(info.version).toBe(engineCheckoutVersion());
    expect(config.runtimeId).toBe(info.runtimeId);
    expect(status.runtimeId).toBe(info.runtimeId);
  });

  test("/info riporta il workspace dentro il container e il listener effettivo", async ({ request }) => {
    const info = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/info");

    // L'identità del workspace è ricostruibile dai percorsi (contratto di GET /info).
    const expectedId = `workspace-v1:${crypto
      .createHash("sha256")
      .update(JSON.stringify([CONTAINER_MOCKS_DIR, CONTAINER_FILES_DIR]), "utf8")
      .digest("hex")}`;
    expect(info.workspace).toEqual({
      id: expectedId,
      root: null,
      mocksDir: CONTAINER_MOCKS_DIR,
      filesDir: CONTAINER_FILES_DIR,
    });

    // Il motore ascolta sulla porta interna del container, non su quella pubblicata sull'host.
    const publishedPort = Number(new URL(stack.mockxyDiscoveryBaseUrl).port);
    expect(info.listener).toEqual({ host: "0.0.0.0", port: 3000 });
    expect(info.listener.port).not.toBe(publishedPort);

    // L'immagine standalone non osserva il filesystem.
    expect(info.watcher).toEqual({ state: "disabled", polling: false, lastError: null });
  });

  test("/config rappresenta le impostazioni dichiarate dalla fixture, senza override", async ({ request }) => {
    const config = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/config");
    const info = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/info");

    expect(config.startup).toEqual(DISCOVERY_FIXTURE_CONFIG);
    expect(config.effective).toEqual(DISCOVERY_FIXTURE_CONFIG);
    expect(config.overrides).toEqual({});
    expect(config.persisted).toBe(false);
    expect(info.revisions.config).toBe(1);
  });

  test("/runtime/status descrive il caricamento di avvio riuscito", async ({ request }) => {
    const status = await adminJson(request, stack.mockxyDiscoveryBaseUrl, "/runtime/status");

    expect(status.lastAttempt).toMatchObject({ id: 1, reasons: ["startup"], status: "applied" });
    expect(status.lastAppliedAttemptId).toBe(1);
    expect(status.errors).toEqual([]);
    expect(status.fatalError).toBeNull();
  });
});

test.describe("accesso alle rotte di discovery", () => {
  test.describe("dal client HTTP", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "solo client HTTP: il motore del browser non cambia l'esito"
    );

    test("con l'admin disabilitata rispondono 404 dal motore, non dal backend del proxy fallback", async ({ request }) => {
      // mockxy-raw: admin spenta dal default dell'immagine, proxy fallback attivo. Contrasto:
      // un path sconosciuto fuori dall'admin arriva davvero al backend.
      const proxied = await request.get(`${stack.mockxyRawBaseUrl}/discovery-contrast`);
      expect(proxied.status()).toBe(404);
      expect(await proxied.json()).toMatchObject({ source: "backend" });

      for (const route of DISCOVERY_ROUTES) {
        const response = await request.get(adminUrl(stack.mockxyRawBaseUrl, route));
        expect(response.status(), route).toBe(404);
        const body = await response.json();
        expect(body, route).toMatchObject({ error: "Admin API disabled" });
        expect(body.source, route).toBeUndefined();
      }
    });

    test("un Host fuori dall'allowlist riceve 403 su ciascuna rotta", async ({ request }) => {
      for (const route of DISCOVERY_ROUTES) {
        const response = await request.get(adminUrl(stack.mockxyDiscoveryBaseUrl, route), {
          headers: { host: "attaccante.example" },
        });
        expect(response.status(), route).toBe(403);
      }
      // Contrasto: con l'Host ammesso la stessa rotta risponde.
      const allowed = await request.get(adminUrl(stack.mockxyDiscoveryBaseUrl, "/info"));
      expect(allowed.status()).toBe(200);
    });
  });

  // Semantica CORS del browser: gira sui tre motori.
  test("il browser sull'origine del client non legge le rotte di discovery, anche con CORS attivo", async ({ page }) => {
    await page.goto("/");

    // Contrasto: il traffico applicativo della stessa istanza è leggibile cross-origin.
    const application = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyDiscoveryBaseUrl}/agent-ready`
    );
    expect(application).toMatchObject({ blocked: false, status: 200, body: { ready: true } });

    for (const route of DISCOVERY_ROUTES) {
      const result = await page.evaluate(
        (url) => window.callApi(url),
        adminUrl(stack.mockxyDiscoveryBaseUrl, route)
      );
      expect(result.blocked, route).toBe(true);
    }
  });
});
