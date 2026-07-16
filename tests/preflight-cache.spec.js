const { execSync } = require("child_process");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");

const COMPOSE_DIR = path.join(__dirname, "..");

// Ricrea l'istanza commutabile con il CORS nello stato richiesto (vedi docker-compose.yml:
// CORS_ENABLED legge TOGGLE_CORS_ENABLED). Compose ricrea il container solo se l'env cambia.
// --no-deps: il compose non deve nemmeno GUARDARE le istanze condivise (mockxy, backend)
// mentre gli altri test le stanno usando.
function setToggleCors(enabled) {
  execSync("docker compose up -d --no-deps mockxy-toggle", {
    cwd: COMPOSE_DIR,
    env: { ...process.env, TOGGLE_CORS_ENABLED: String(enabled) },
    stdio: "ignore",
  });
}

// Il preflight automatico risponde 204 con x-mock-source: cors-preflight solo a CORS attivo:
// distingue lo stato dell'istanza senza dipendere dal browser.
async function isPreflightHandled(request) {
  const response = await request.fetch(`${stack.mockxyToggleBaseUrl}/api/tracked`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:8081",
      "access-control-request-method": "POST",
    },
  });
  return response.status() === 204 && response.headers()["x-mock-source"] === "cors-preflight";
}

async function waitForToggleCorsState(request, expectedEnabled, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const reachable = (await request.get(`${stack.mockxyToggleBaseUrl}/hello`)).ok();
      if (reachable && (await isPreflightHandled(request)) === expectedEnabled) {
        return;
      }
    } catch {
      /* container in ricreazione: si riprova */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`l'istanza commutabile non ha raggiunto CORS=${expectedEnabled} entro ${timeoutMs}ms`);
}

async function readTrackedCount(request) {
  const response = await request.get(`${stack.backendDirectBaseUrl}/api/tracked-count`);
  return (await response.json()).count;
}

function postTrackedFromPage(page) {
  return page.evaluate(
    (url) =>
      window.callApi(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "preflight-cache-test" }),
      }),
    `${stack.mockxyToggleBaseUrl}/api/tracked`
  );
}

// Il caveat documentato in docs/CORS.md: spegnendo il CORS, per qualche minuto il browser
// può ancora usare i preflight in cache (Access-Control-Max-Age: 600). Il contatore del
// backend rende osservabile la differenza: una POST con preflight IN CACHE parte comunque
// (risposta poi bloccata, ma il backend la riceve); senza cache il preflight fallisce e
// la POST non lascia mai il browser.
test.describe("cache dei preflight", () => {
  // Test che ricrea un container: gira nel project dedicato chromium-stack-mutating, DOPO
  // tutti gli altri e mai in concorrenza (vedi playwright.config.js) — la ricreazione può
  // resettare connessioni verso le altre istanze pubblicate.

  test("a CORS spento un preflight in cache fa ancora partire la richiesta, uno nuovo no", async ({
    page,
    browser,
    request,
  }) => {
    try {
      // Stato di partenza deterministico: CORS attivo e contatore azzerato.
      setToggleCors(true);
      await waitForToggleCorsState(request, true);
      await request.post(`${stack.backendDirectBaseUrl}/api/tracked-reset`);

      // 1. POST preflighted a CORS attivo: passa, e il preflight entra in cache (Max-Age 600).
      await page.goto("/");
      const whileCorsOn = await postTrackedFromPage(page);
      expect(whileCorsOn.blocked).toBe(false);
      expect(whileCorsOn.status).toBe(200);
      expect(await readTrackedCount(request)).toBe(1);

      // 2. CORS spento a metà corsa.
      setToggleCors(false);
      await waitForToggleCorsState(request, false);

      // 3. Stessa pagina, preflight in cache: la POST parte comunque e ARRIVA al backend;
      //    è la risposta, ormai senza header CORS, a venire bloccata dal browser.
      const cachedPreflight = await postTrackedFromPage(page);
      expect(cachedPreflight.blocked).toBe(true);
      expect(await readTrackedCount(request)).toBe(2);

      // 4. Contesto browser nuovo (cache preflight vuota): il preflight fallisce e la POST
      //    non parte proprio — il contatore non si muove.
      const freshContext = await browser.newContext();
      const freshPage = await freshContext.newPage();
      await freshPage.goto(stack.clientPageUrl);
      const withoutCache = await postTrackedFromPage(freshPage);
      expect(withoutCache.blocked).toBe(true);
      expect(await readTrackedCount(request)).toBe(2);
      await freshContext.close();
    } finally {
      // Lo stack torna com'era, qualunque cosa sia successa.
      setToggleCors(true);
      await waitForToggleCorsState(request, true);
    }
  });
});
