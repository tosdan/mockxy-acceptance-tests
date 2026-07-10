const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// La sessione a cookie attraverso il proxy: il backend risponde al login con un Set-Cookie
// scritto per il SUO dominio su https (Domain, Secure, SameSite=None). Senza adattamento il
// browser lo scarterebbe in silenzio — il classico login che "non tiene".
test.describe("cookie di sessione attraverso il proxy", () => {
  test("login → cookie adattato e conservato → richiesta successiva autenticata", async ({ page }) => {
    await page.goto("/");

    const loginResult = await page.evaluate(
      (url) => window.callApi(url, { method: "POST", credentials: "include" }),
      `${stack.mockxyBaseUrl}/api/login`
    );
    expect(loginResult.blocked).toBe(false);
    expect(loginResult.body.loggedIn).toBe(true);

    // Il browser deve aver registrato il cookie come cookie DELL'HOST DI MOCKXY.
    const cookies = await page.context().cookies(stack.mockxyBaseUrl);
    const sessionCookie = cookies.find((cookie) => cookie.name === "session");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.value).toBe("backend-session-token");
    expect(sessionCookie.secure).toBe(false); // Secure rimosso dall'adattamento

    // E deve allegarlo alla chiamata successiva: il backend lo vede arrivare via proxy.
    const whoamiResult = await page.evaluate(
      (url) => window.callApi(url, { credentials: "include" }),
      `${stack.mockxyBaseUrl}/api/whoami`
    );
    expect(whoamiResult.blocked).toBe(false);
    expect(whoamiResult.body.cookie).toContain("session=backend-session-token");
  });

  test("l'adattamento rimuove Domain, Secure e SameSite=None preservando il resto", async ({ request }) => {
    // Verifica a livello di header (fuori dal browser) sull'istanza con adattamento ATTIVO.
    const response = await request.post(`${stack.mockxyBaseUrl}/api/login`);
    const setCookie = response.headers()["set-cookie"];

    expect(setCookie).toContain("session=backend-session-token");
    expect(setCookie).toContain("HttpOnly"); // attributo estraneo: passa intatto
    expect(setCookie).toContain("Path=/");
    expect(setCookie.toLowerCase()).not.toContain("domain=");
    expect(setCookie.toLowerCase()).not.toContain("secure");
    expect(setCookie.toLowerCase()).not.toContain("samesite=none");
  });

  test("con l'adattamento spento il Set-Cookie del backend passa intatto", async ({ request }) => {
    const response = await request.post(`${stack.mockxyRawBaseUrl}/api/login`);
    const setCookie = response.headers()["set-cookie"];

    expect(setCookie).toContain("session=backend-session-token");
    expect(setCookie).toContain("Domain=staging.example");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=None");
  });
});
