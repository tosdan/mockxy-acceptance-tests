const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// La latenza simulata (istanza dedicata con MOCKXY_DELAY=600 e MOCKXY_DELAY_ALL=true):
// il ritardo globale vale per i mock senza delayMs proprio e, col flag, anche per le
// richieste proxate. Margini larghi sulle asserzioni temporali per non essere fragili.
test.describe("latenza simulata", () => {
  test("un mock senza ritardo proprio riceve il ritardo globale", async ({ request }) => {
    const startedAt = Date.now();
    const response = await request.get(`${stack.mockxyDelayBaseUrl}/hello`);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ message: "hello from mock" });
    expect(elapsedMs).toBeGreaterThanOrEqual(550);
  });

  test("con MOCKXY_DELAY_ALL anche le richieste proxate vengono ritardate", async ({ request }) => {
    const startedAt = Date.now();
    const response = await request.get(`${stack.mockxyDelayBaseUrl}/api/ping`);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ source: "backend", pong: true });
    expect(elapsedMs).toBeGreaterThanOrEqual(550);
  });

  test("contrasto: senza ritardo globale lo stesso mock risponde subito", async ({ request }) => {
    // Il minimo su più tentativi assorbe i picchi di contesa della suite in parallelo
    // (altri worker, ricreazioni di container): basta UNA risposta rapida per dimostrare
    // che qui non c'è alcun ritardo configurato.
    let fastestMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      const response = await request.get(`${stack.mockxyBaseUrl}/hello`);
      expect(response.status()).toBe(200);
      fastestMs = Math.min(fastestMs, Date.now() - startedAt);
    }

    expect(fastestMs).toBeLessThan(400);
  });
});
