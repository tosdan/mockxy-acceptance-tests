const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Smoke: lo stack risponde e la provenienza (x-mock-source) è leggibile dal browser
// cross-origin — il che prova anche Access-Control-Expose-Headers, senza il quale il
// JavaScript non potrebbe leggere quell'header.
test.describe("smoke attraverso il browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("un mock viene servito cross-origin con x-mock-source leggibile", async ({ page }) => {
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/hello`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ message: "hello from mock" });
    expect(result.headers["x-mock-source"]).toBe("mock");
  });

  test("una rotta non mockata arriva al backend via proxy fallback", async ({ page }) => {
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/api/ping`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ source: "backend", pong: true });
    expect(result.headers["x-mock-source"]).toBe("backend");
  });

  test("la policy CORS del backend viene sovrascritta da quella di Mockxy", async ({ page }) => {
    // Il backend finto dichiara Access-Control-Allow-Origin: https://frontend-di-staging.example
    // su OGNI risposta: se Mockxy non la sovrascrivesse con l'eco dell'origin del client,
    // il browser bloccherebbe questa fetch.
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/api/ping`
    );

    expect(result.blocked).toBe(false);
    expect(result.ok).toBe(true);
  });
});
