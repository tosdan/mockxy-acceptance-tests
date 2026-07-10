const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// La semantica del timeout del proxy (docs/PROXY.md del motore): copre solo fino ai PRIMI
// header di risposta. L'istanza raw ha REQUEST_TIMEOUT_MS=1000 (vedi docker-compose.yml);
// quella principale resta al default di 15s.
test.describe("timeout del proxy", () => {
  test("un backend che non risponde entro il timeout produce un 502, senza aspettarlo", async ({ request }) => {
    const startedAt = Date.now();
    const response = await request.get(`${stack.mockxyRawBaseUrl}/api/slow?ms=3000`);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status()).toBe(502);
    // Il 502 arriva allo scadere del timeout (1s), non alla fine dell'attesa del backend (3s).
    expect(elapsedMs).toBeLessThan(2900);
  });

  test("header subito e body lento: il timeout non tronca la risposta avviata", async ({ request }) => {
    // Il ritardo (2.5s) supera il timeout (1s), ma gli header sono già arrivati:
    // la risposta deve completarsi integra, non diventare 502.
    const response = await request.get(`${stack.mockxyRawBaseUrl}/api/slow-stream?ms=2500`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ source: "backend", streamed: true });
  });

  test("entro il timeout un backend lento risponde normalmente", async ({ request }) => {
    // Istanza principale, timeout al default (15s): 2s di attesa sono legittimi.
    const response = await request.get(`${stack.mockxyBaseUrl}/api/slow?ms=2000`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ source: "backend", sleptMs: 2000 });
  });
});
