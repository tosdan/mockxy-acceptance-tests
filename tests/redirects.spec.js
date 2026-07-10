const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// I redirect proxati: un Location assoluto verso il backend farebbe evadere il browser da
// Mockxy — e in questo stack l'indirizzo interno (http://backend:9000) non è nemmeno
// risolvibile dall'host, quindi senza riscrittura il flusso muore davvero.
test.describe("riscrittura dei redirect proxati", () => {
  test("il browser segue il redirect assoluto e resta su Mockxy", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/api/redirect-absolute`
    );

    expect(result.blocked).toBe(false);
    expect(result.redirected).toBe(true);
    expect(result.url).toBe(`${stack.mockxyBaseUrl}/api/landing?from=redirect`);
    expect(result.body).toEqual({ source: "backend", landed: true, from: "redirect" });
  });

  test("il Location assoluto verso il backend viene riscritto sull'host di Mockxy", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/api/redirect-absolute`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe(
      `${stack.mockxyBaseUrl}/api/landing?from=redirect`
    );
  });

  test("i Location relativi passano intatti", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/api/redirect-relative`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/api/landing");
  });

  test("i redirect verso host terzi passano intatti", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/api/redirect-third-party`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("https://sso.example/authorize?client=mockxy");
  });

  test("con la riscrittura spenta il Location del backend passa intatto", async ({ request }) => {
    const response = await request.get(`${stack.mockxyRawBaseUrl}/api/redirect-absolute`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("http://backend:9000/api/landing?from=redirect");
  });
});
