const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Le difese dell'admin API viste da fuori: l'istanza principale la espone con
// ADMIN_ALLOWED_HOSTS=localhost, che attiva la guardia DNS-rebinding anche sul bind
// di rete del container.
test.describe("admin API attraverso il container", () => {
  test("il catalogo admin elenca i mock del workspace montato", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`);

    expect(response.status()).toBe(200);
    const catalog = await response.json();
    const paths = catalog.items.map((item) => item.path);
    expect(paths).toContain("/hello");
    expect(paths).toContain("/logo");
  });

  test("la guardia DNS-rebinding rifiuta un Host estraneo sull'admin API ma non sui mock", async ({ request }) => {
    // Un sito ostile che ri-risolve il proprio dominio su 127.0.0.1 arriva con l'Host
    // dell'attaccante: l'admin deve rifiutarlo, i mock devono restare serviti.
    const adminResponse = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`, {
      headers: { host: "attaccante.example" },
    });
    expect(adminResponse.status()).toBe(403);

    const mockResponse = await request.get(`${stack.mockxyBaseUrl}/hello`, {
      headers: { host: "attaccante.example" },
    });
    expect(mockResponse.status()).toBe(200);
  });

  test("un import OpenAPI text/plain dal browser (vettore CSRF) non crea nulla", async ({ page, request }) => {
    await page.goto("/");
    const catalogBefore = await (await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`)).json();

    // text/plain è una richiesta "semplice": parte SENZA preflight anche cross-origin —
    // è esattamente il vettore CSRF. Il server la respinge (415, verificato più sotto a
    // livello di protocollo) e per il JS la risposta è comunque opaca: la superficie CORS
    // di Mockxy copre solo mock/handler/proxy, mai l'admin API.
    const result = await page.evaluate(
      (url) =>
        window.callApi(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "openapi: 3.0.0\ninfo:\n  title: csrf\n  version: 1.0.0\npaths: {}\n",
        }),
      `${stack.mockxyBaseUrl}/_admin/api/mocks/import/openapi`
    );
    expect(result.blocked).toBe(true);

    // A livello di protocollo la guardia risponde 415 (Unsupported Media Type)...
    const protocolResponse = await request.post(
      `${stack.mockxyBaseUrl}/_admin/api/mocks/import/openapi`,
      { headers: { "content-type": "text/plain" }, data: "openapi: 3.0.0\npaths: {}\n" }
    );
    expect(protocolResponse.status()).toBe(415);

    // ...e non è stato creato nulla.
    const catalogAfter = await (await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`)).json();
    expect(catalogAfter.items.length).toBe(catalogBefore.items.length);
  });

  test("l'admin API non è leggibile cross-origin nemmeno con CORS attivo", async ({ page }) => {
    // La policy a eco copre solo ciò che il motore SERVE (mock, handler, proxy): le risposte
    // dell'admin non vengono mai decorate, quindi restano opache per il JS di altre origin —
    // un sito ostile non può leggere il catalogo.
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/_admin/api/mocks`
    );

    expect(result.blocked).toBe(true);
  });
});
