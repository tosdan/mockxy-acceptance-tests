const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Il CORS è applicato dal BROWSER: questi test valgono solo perché partono da una pagina
// servita su un'altra origin (localhost:8081 → localhost:8080).
test.describe("CORS dal browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("con CORS spento il browser blocca la fetch cross-origin", async ({ page }) => {
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyRawBaseUrl}/hello`
    );

    // Stessa rotta, stessa immagine: cambia solo CORS_ENABLED=false → fetch respinta.
    expect(result.blocked).toBe(true);
    expect(result.errorName).toBe("TypeError");
  });

  test("una POST JSON supera il preflight automatico e arriva al backend", async ({ page }) => {
    // content-type application/json rende la richiesta "non semplice": il browser manda
    // prima una OPTIONS di preflight. Se Mockxy non la gestisse, la POST non partirebbe mai.
    const result = await page.evaluate(
      (url) =>
        window.callApi(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ greeting: "dal client" }),
        }),
      `${stack.mockxyBaseUrl}/api/echo-json`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body.received).toEqual({ greeting: "dal client" });
    expect(result.body.contentType).toContain("application/json");
  });

  test("un header custom viene ammesso dal preflight a eco e inoltrato", async ({ page }) => {
    const result = await page.evaluate(
      (url) =>
        window.callApi(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "chiave-di-prova",
          },
          body: JSON.stringify({}),
        }),
      `${stack.mockxyBaseUrl}/api/echo-json`
    );

    expect(result.blocked).toBe(false);
    expect(result.body.apiKey).toBe("chiave-di-prova");
  });

  test("un mock OPTIONS esplicito ha la precedenza sul preflight automatico", async ({ page }) => {
    // Comportamento documentato in docs/CORS.md: se sulla rotta esiste un mock OPTIONS,
    // il gestore automatico si fa da parte. Il mock di fixture non emette header CORS,
    // quindi il preflight della POST fallisce e il browser blocca la richiesta.
    const result = await page.evaluate(
      (url) =>
        window.callApi(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      `${stack.mockxyBaseUrl}/custom-options`
    );

    expect(result.blocked).toBe(true);
  });

  test("il preflight automatico risponde 204 con eco di origin e header", async ({ request }) => {
    // Verifica di contorno a livello di protocollo (fuori dal browser): la forma esatta
    // della risposta di preflight documentata in docs/CORS.md.
    const response = await request.fetch(`${stack.mockxyBaseUrl}/api/ping`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:8081",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-api-key",
      },
    });

    expect(response.status()).toBe(204);
    expect(response.headers()["x-mock-source"]).toBe("cors-preflight");
    expect(response.headers()["access-control-allow-origin"]).toBe("http://localhost:8081");
    expect(response.headers()["access-control-allow-credentials"]).toBe("true");
    expect(response.headers()["access-control-allow-headers"]).toContain("x-api-key");
  });
});
