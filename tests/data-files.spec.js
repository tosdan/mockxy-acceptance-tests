const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// File dati + handler nell'immagine standalone: un handler che fa `await data("mydata")`
// deve servire il contenuto di workspace/files/mydata.json. È il ponte tra due bind mount
// distinti (mocks e files) che solo il packaging reale può rompere: FILES_DIR non
// impostata/mal risolta nell'immagine, mount mancante, o il contesto handler senza data().
test.describe("handler con file dati attraverso il browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("un handler che legge un file dati con data() lo serve al browser", async ({ page }) => {
    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/data-handler`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.headers["x-mock-source"]).toBe("handler");
    expect(result.body).toEqual({
      source: "data-file",
      items: [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ],
    });
  });
});
