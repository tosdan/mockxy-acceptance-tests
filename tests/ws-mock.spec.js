const { test, expect } = require("@playwright/test");
const stack = require("./stack");

const WS_BASE = stack.mockxyBaseUrl.replace("http://", "ws://");

async function mockIdForPath(request, mockPath) {
  const response = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  const item = catalog.items.find((candidate) => candidate.path === mockPath);
  expect(item, `endpoint ${mockPath} non trovato nel catalogo admin`).toBeTruthy();
  return item.id;
}

// I mock WebSocket con WebSocket vera del browser: /ws-script ha un copione a tre messaggi
// (0/500/1000ms, onEnd keep-open), /ws-rules è muto e risponde solo alle regole, /ws-close
// chiude dal server con codice applicativo, /ws-console riceve solo dalla regia manuale.
test.describe("mock WebSocket con copione", () => {
  test("il copione va in onda progressivamente, non bufferizzato", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.wsCollect(url, 3),
      `${WS_BASE}/ws-script`
    );

    expect(result.timedOut).toBe(false);
    expect(result.opened).toBe(true);
    expect(result.messages.map((message) => message.data)).toEqual(["uno", "due", "tre"]);
    // afterMs sono relativi al messaggio precedente (500 + 1000): se il motore sparasse
    // tutto il copione in un colpo, i timestamp risulterebbero appiattiti.
    const spreadMs = result.messages[2].atMs - result.messages[0].atMs;
    expect(spreadMs).toBeGreaterThanOrEqual(1200);
  });

  test("ogni connessione riparte dall'inizio del copione", async ({ page }) => {
    await page.goto("/");

    const firstRun = await page.evaluate(
      (url) => window.wsCollect(url, 3),
      `${WS_BASE}/ws-script`
    );
    expect(firstRun.timedOut).toBe(false);

    // Seconda connessione dallo stesso client: il copione non è stato "consumato" —
    // riparte da "uno", indipendente per ciascuna connessione.
    const secondRun = await page.evaluate(
      (url) => window.wsCollect(url, 1),
      `${WS_BASE}/ws-script`
    );
    expect(secondRun.timedOut).toBe(false);
    expect(secondRun.messages[0].data).toBe("uno");
  });

  test("con onEnd close il server chiude e il browser vede codice e reason applicativi", async ({ page }) => {
    await page.goto("/");

    // expectedCount null: si resta in ascolto finché il SERVER chiude — la risoluzione
    // stessa prova che la chiusura è partita dal mock, non dal client.
    const result = await page.evaluate(
      (url) => window.wsCollect(url, null),
      `${WS_BASE}/ws-close`
    );

    expect(result.timedOut).toBe(false);
    expect(result.messages.map((message) => message.data)).toEqual(["fine"]);
    expect(result.closeWasClean).toBe(true);
    expect(result.closeCode).toBe(4001);
    expect(result.closeReason).toBe("lavoro concluso");
  });

  test("una GET normale sull'endpoint ws risponde 426 Upgrade Required", async ({ page }) => {
    await page.goto("/");

    // Una fetch senza upgrade non è una WebSocket: il mock non degrada a passthrough
    // ma dichiara al client che la rotta esiste e vuole l'upgrade.
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/ws-script`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(426);
  });
});

test.describe("mock WebSocket con regole di risposta", () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.wsCloseAll());
  });

  test("la regola risponde solo alla connessione che ha parlato", async ({ page }) => {
    await page.goto("/");

    await page.evaluate((url) => window.wsOpen("talker", url), `${WS_BASE}/ws-rules`);
    await page.evaluate((url) => window.wsOpen("listener", url), `${WS_BASE}/ws-rules`);

    await page.evaluate(() => window.wsSend("talker", "ping"));
    await expect
      .poll(() => page.evaluate(() => window.wsReceived("talker").map((message) => message.data)))
      .toEqual(["pong"]);

    // Il vicino di canale non riceve nulla: la reply non è un broadcast.
    expect(await page.evaluate(() => window.wsReceived("listener"))).toEqual([]);
  });

  test("il match json è un subset: la reply a più voci arriva coi suoi tempi", async ({ page }) => {
    await page.goto("/");

    await page.evaluate((url) => window.wsOpen("solo", url), `${WS_BASE}/ws-rules`);
    await page.evaluate(() =>
      window.wsSend("solo", JSON.stringify({ azione: "subscribe", canale: "news" }))
    );

    await expect
      .poll(() => page.evaluate(() => window.wsReceived("solo").length))
      .toBe(2);
    const received = await page.evaluate(() => window.wsReceived("solo"));
    expect(JSON.parse(received[0].data)).toEqual({ esito: "ok" });
    expect(JSON.parse(received[1].data)).toEqual({ tipo: "aggiornamento", n: 1 });
    // La seconda voce della reply ha afterMs 200: consegna cadenzata, non in blocco.
    expect(received[1].atMs - received[0].atMs).toBeGreaterThanOrEqual(150);
  });

  test("un messaggio senza regola non riceve alcun eco", async ({ page }) => {
    await page.goto("/");

    await page.evaluate((url) => window.wsOpen("muto", url), `${WS_BASE}/ws-rules`);
    await page.evaluate(() => window.wsSend("muto", "messaggio qualunque"));

    // Attesa di contrasto: nessuna risposta deve arrivare (niente eco di default).
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.wsReceived("muto"))).toEqual([]);
  });
});

// La console WS fa broadcast a TUTTE le connessioni aperte dell'endpoint: il test gira
// una volta sola (project chromium) per non interferire con se stesso tra i project.
test.describe("console WebSocket via admin API", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: il push è broadcast, una sola esecuzione (project chromium)"
  );

  test("un push manuale raggiunge il browser connesso all'endpoint muto", async ({ page, request }) => {
    const mockId = await mockIdForPath(request, "/ws-console");
    await page.goto("/");

    await page.evaluate((url) => window.wsOpen("console", url), `${WS_BASE}/ws-console`);

    // La connessione è "vera" quando la console la vede: si attende lì, non a tempo.
    await expect
      .poll(async () => {
        const response = await request.get(
          `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/ws/connections`
        );
        const state = await response.json();
        return state.connections.length;
      })
      .toBeGreaterThanOrEqual(1);

    const pushResponse = await request.post(
      `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/ws/push`,
      { data: { data: { message: "ciao dal collaudo" } } }
    );
    expect(pushResponse.status()).toBe(200);
    const pushResult = await pushResponse.json();
    expect(pushResult.delivered).toBeGreaterThanOrEqual(1);

    // Il browser riceve davvero il broadcast, con il payload JSON serializzato.
    await expect
      .poll(() => page.evaluate(() => window.wsReceived("console").length))
      .toBeGreaterThanOrEqual(1);
    const received = await page.evaluate(() => window.wsReceived("console"));
    expect(JSON.parse(received[0].data)).toEqual({ message: "ciao dal collaudo" });

    // Il transcript bidirezionale della console registra il push come regia manuale.
    const state = await request.get(
      `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/ws/connections`
    );
    const transcript = (await state.json()).transcript;
    const manualEntry = transcript.find((entry) => entry.origin === "manual");
    expect(manualEntry).toMatchObject({ direction: "out", data: { message: "ciao dal collaudo" } });

    await page.evaluate(() => window.wsCloseAll());
  });
});
