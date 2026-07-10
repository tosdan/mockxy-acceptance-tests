const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Contenuti "difficili" attraverso lo stack reale: risposte compresse dal backend,
// payload binari serviti da mock file-backed, stream SSE consegnati progressivamente.
test.describe("contenuti difficili", () => {
  test("una risposta gzip del backend arriva integra al browser", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/api/gzipped`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    // Il browser decomprime in trasparenza: se il proxy avesse corrotto lo stream
    // compresso (o pasticciato content-encoding/content-length) qui non arriverebbe JSON.
    expect(result.body).toEqual({ source: "backend", compressed: true });
  });

  test("il mock file-backed binario serve i byte esatti del file", async ({ request }) => {
    const fixtureBytes = fs.readFileSync(
      path.join(__dirname, "..", "workspace", "mocks", "logo", "GET.responses", "001.file.png")
    );

    const response = await request.get(`${stack.mockxyBaseUrl}/logo`);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect((await response.body()).equals(fixtureBytes)).toBe(true);
  });

  test("il browser scarica il binario del mock con firma PNG e dimensione corrette", async ({ page }) => {
    await page.goto("/");
    const fixtureLength = fs.readFileSync(
      path.join(__dirname, "..", "workspace", "mocks", "logo", "GET.responses", "001.file.png")
    ).length;

    const result = await page.evaluate(
      (url) => window.fetchBinary(url),
      `${stack.mockxyBaseUrl}/logo`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(result.byteLength).toBe(fixtureLength);
    // Firma PNG: 89 50 4E 47 0D 0A 1A 0A.
    expect(result.firstBytes).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("un flusso SSE proxato arriva progressivamente, non bufferizzato alla fine", async ({ page }) => {
    await page.goto("/");

    // Il backend emette tre eventi distanziati di 700ms: se il proxy bufferizzasse
    // l'intero stream fino alla chiusura, i tre timestamp risulterebbero appiattiti.
    const result = await page.evaluate(
      (url) => window.sseCollect(url, 3),
      `${stack.mockxyBaseUrl}/api/sse`
    );

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.data)).toEqual(["uno", "due", "tre"]);
    const spreadMs = result.events[2].atMs - result.events[0].atMs;
    expect(spreadMs).toBeGreaterThanOrEqual(600);
  });
});
