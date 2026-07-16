const { test, expect } = require("@playwright/test");
const stack = require("./stack");

async function mockIdForPath(request, mockPath) {
  const response = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  const item = catalog.items.find((candidate) => candidate.path === mockPath);
  expect(item, `endpoint ${mockPath} non trovato nel catalogo admin`).toBeTruthy();
  return item.id;
}

// I mock SSE con EventSource vero: /sse-script ha un copione a tre eventi (0/500/1000ms,
// onEnd keep-open), /sse-console è muto e riceve solo dalla regia manuale dell'admin API.
test.describe("mock SSE con copione", () => {
  test("il copione va in onda progressivamente, non bufferizzato", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.sseCollect(url, 3),
      `${stack.mockxyBaseUrl}/sse-script`
    );

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.data)).toEqual(["uno", "due", "tre"]);
    // afterMs sono relativi al messaggio precedente (500 + 1000): se il motore sparasse
    // tutto il copione in un colpo, i timestamp risulterebbero appiattiti.
    const spreadMs = result.events[2].atMs - result.events[0].atMs;
    expect(spreadMs).toBeGreaterThanOrEqual(1200);
  });

  test("ogni connessione riparte dall'inizio del copione", async ({ page }) => {
    await page.goto("/");

    // Prima connessione: si consuma l'intero copione e si chiude (sseCollect chiude al terzo).
    const firstRun = await page.evaluate(
      (url) => window.sseCollect(url, 3),
      `${stack.mockxyBaseUrl}/sse-script`
    );
    expect(firstRun.timedOut).toBe(false);

    // Seconda connessione dallo stesso client: il copione non è stato "consumato" —
    // riparte da "uno", indipendente per ciascuna connessione.
    const secondRun = await page.evaluate(
      (url) => window.sseCollect(url, 1),
      `${stack.mockxyBaseUrl}/sse-script`
    );
    expect(secondRun.timedOut).toBe(false);
    expect(secondRun.events[0].data).toBe("uno");
  });
});

// La console SSE fa broadcast a TUTTE le connessioni aperte dell'endpoint: il test gira
// una volta sola (project chromium) per non interferire con se stesso tra i project.
test.describe("console SSE via admin API", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: il push è broadcast, una sola esecuzione (project chromium)"
  );

  test("un push manuale raggiunge il browser connesso all'endpoint muto", async ({ page, request }) => {
    const mockId = await mockIdForPath(request, "/sse-console");
    await page.goto("/");

    // Si apre l'EventSource SENZA attendere: la promise resta pending finché non
    // arriva il primo evento (l'endpoint è muto, arriverà solo dal push).
    await page.evaluate(
      (url) => {
        window.ssePending = window.sseCollect(url, 1);
      },
      `${stack.mockxyBaseUrl}/sse-console`
    );

    // La connessione è "vera" quando la console la vede: si attende lì, non a tempo.
    await expect
      .poll(async () => {
        const response = await request.get(
          `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/sse/connections`
        );
        const state = await response.json();
        return state.connections.length;
      })
      .toBeGreaterThanOrEqual(1);

    const pushResponse = await request.post(
      `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/sse/push`,
      { data: { data: { message: "ciao dal collaudo" } } }
    );
    expect(pushResponse.status()).toBe(200);
    const pushResult = await pushResponse.json();
    expect(pushResult.delivered).toBeGreaterThanOrEqual(1);

    // Il browser riceve davvero il broadcast, con il payload JSON serializzato.
    const collected = await page.evaluate(() => window.ssePending);
    expect(collected.timedOut).toBe(false);
    expect(JSON.parse(collected.events[0].data)).toEqual({ message: "ciao dal collaudo" });
  });
});
