const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Helper condivisi nell'immagine standalone. Gli handler importano `#shared/saluti/formato.js`,
// che a sua volta importa un altro helper con lo stesso alias. L'alias è quello nativo di Node,
// definito da `mocks/package.json`: qui il workspace è un bind mount IN SOLA LETTURA, quindi il
// motore non può creare quel file. Funziona perché è versionato insieme ai mock. È il caso
// che solo il packaging reale può rompere: file non montato, ambito del package diverso
// nell'immagine, risoluzione che dipende dalla profondità della cartella.

const ADMIN = `${stack.mockxyBaseUrl}/_admin/api`;

test.describe("helper condivisi con l'alias #shared", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("lo stesso import risolve da cartelle di profondità diversa, anche dentro gli helper", async ({ page }) => {
    const call = (path) => page.evaluate((url) => window.callApi(url), `${stack.mockxyBaseUrl}${path}`);

    const shallow = await call("/shared-helper/Ada?lingua=en");
    const deep = await call("/shared-helper/annidato/in/profondita/Ada");

    expect(shallow.status).toBe(200);
    expect(shallow.headers["x-mock-source"]).toBe("handler");
    expect(shallow.body).toEqual({ saluto: "Hello, Ada!", profondita: 2 });
    expect(deep.status).toBe(200);
    expect(deep.body).toEqual({ saluto: "Ciao, Ada!", profondita: 5 });
  });
});

test.describe("stato del runtime e validazione degli script", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "solo client HTTP: il motore del browser non cambia l'esito"
  );

  test("con il package versionato il mount in sola lettura non produce avvisi", async ({ request }) => {
    const response = await request.get(`${ADMIN}/runtime/status`);
    expect(response.status()).toBe(200);
    const status = await response.json();

    expect(status.lastAttempt.status).toBe("applied");
    expect(status.errors).toEqual([]);
    // Senza `mocks/package.json` qui comparirebbe SCRIPT_PACKAGE_NOT_CREATABLE.
    expect(status.warnings).toEqual([]);
  });

  test("la validazione completa trova conformi tutti gli script del workspace", async ({ request }) => {
    // Come le altre POST senza parametri dell'admin: corpo JSON esattamente `{}`.
    const response = await request.post(`${ADMIN}/scripts/validate`, { data: {} });
    expect(response.status()).toBe(200);
    const report = await response.json();

    expect(report).toMatchObject({ ok: true, mocksDir: "/workspace/mocks", errors: [], warnings: [] });
    // Handler e middleware del workspace, compresi i due che usano l'helper condiviso.
    expect(report.scripts).toBeGreaterThanOrEqual(6);
  });
});
