const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Il passthrough WebSocket: l'upgrade parte dal browser, attraversa Mockxy e finisce
// sull'echo del backend. Si verifica il giro completo nei due versi (push iniziale del
// server, eco del messaggio del client) e che i frame di chiusura round-trippino il
// codice e la reason attraverso il tunnel.
test.describe("WebSocket passthrough", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("controllo: l'echo del backend risponde in diretta (senza Mockxy)", async ({ page }) => {
    // Isola i guasti: se questo fallisce è rotto il backend finto, non il passthrough.
    const transcript = await page.evaluate(
      ({ url, message }) => window.wsRoundTrip(url, message, 1000, "fine controllo"),
      { url: "ws://localhost:9090/ws/echo", message: "diretto" }
    );

    expect(transcript.opened).toBe(true);
    expect(transcript.received).toEqual(["hello from backend ws", "echo: diretto"]);
    expect(transcript.closeWasClean).toBe(true);
  });

  test("il tunnel attraverso Mockxy fa il giro completo nei due versi", async ({ page }) => {
    const transcript = await page.evaluate(
      ({ url, message }) => window.wsRoundTrip(url, message, 1000, "arrivederci"),
      { url: `${stack.mockxyBaseUrl.replace("http://", "ws://")}/ws/echo`, message: "attraverso il proxy" }
    );

    expect(transcript.timedOut).toBe(false);
    expect(transcript.error).toBe(false);
    expect(transcript.opened).toBe(true);
    // Primo messaggio: push iniziato dal BACKEND (verso backend → client attraverso il tunnel);
    // secondo: eco del messaggio del client (verso client → backend).
    expect(transcript.received).toEqual([
      "hello from backend ws",
      "echo: attraverso il proxy",
    ]);
    expect(transcript.closeWasClean).toBe(true);
    expect(transcript.closeCode).toBe(1000);
  });

  test("un codice di chiusura applicativo round-trippa attraverso il tunnel", async ({ page }) => {
    // Il backend echo rimanda indietro il payload del frame di close: se il codice 4001
    // e la reason tornano al client, i frame di chiusura passano intatti nei due versi.
    const transcript = await page.evaluate(
      ({ url, message }) => window.wsRoundTrip(url, message, 4001, "motivo applicativo"),
      { url: `${stack.mockxyBaseUrl.replace("http://", "ws://")}/ws/echo`, message: "chiusura" }
    );

    expect(transcript.closeWasClean).toBe(true);
    expect(transcript.closeCode).toBe(4001);
    expect(transcript.closeReason).toBe("motivo applicativo");
  });
});
