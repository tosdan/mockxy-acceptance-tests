const { test, expect } = require("@playwright/test");
const stack = require("./stack");

const resourceUrl = `${stack.mockxyBaseUrl}/shared-items`;
const resetUrl = `${stack.mockxyBaseUrl}/_admin/api/runtime/shared-state/shared-items/reset`;

async function resetSharedItems(request) {
  const response = await request.post(resetUrl, { data: {} });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ name: "shared-items" });
}

// Lo store è globale all'istanza: questi scenari mutano la stessa risorsa e girano una sola
// volta, in serie su Chromium. Ogni test parte da un reset amministrativo esplicito.
test.describe("stato runtime condiviso visto da un frontend reale", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: una sola esecuzione (project chromium)"
  );

  test.beforeEach(async ({ page, request }) => {
    await resetSharedItems(request);
    await page.goto("/");
  });

  test("GET seed → POST arbitraria → GET arricchita → reset → GET seed", async ({ page, request }) => {
    const initial = await page.evaluate((url) => window.callApi(url), resourceUrl);
    expect(initial).toMatchObject({ blocked: false, status: 200 });
    expect(initial.body).toEqual([
      { id: "seed-1", name: "Seed item", category: "seed" },
    ]);

    const payload = {
      name: "Creato dal frontend",
      category: "user",
      nested: { arbitrary: true },
    };
    const created = await page.evaluate(
      ({ url, body }) => window.callApi(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { url: resourceUrl, body: payload }
    );
    expect(created).toMatchObject({ blocked: false, status: 201 });
    expect(created.body).toMatchObject(payload);
    expect(created.body.id).toEqual(expect.any(String));

    const afterPost = await page.evaluate((url) => window.callApi(url), resourceUrl);
    expect(afterPost.body).toEqual([
      { id: "seed-1", name: "Seed item", category: "seed" },
      created.body,
    ]);

    await resetSharedItems(request);
    const afterReset = await page.evaluate((url) => window.callApi(url), resourceUrl);
    expect(afterReset.body).toEqual([
      { id: "seed-1", name: "Seed item", category: "seed" },
    ]);
  });

  test("la GET stateful mantiene filtri, pagina e X-Total-Count", async ({ page }) => {
    for (const item of [
      { id: "a", name: "Alpha", category: "user" },
      { id: "b", name: "Beta", category: "USER" },
    ]) {
      const response = await page.evaluate(
        ({ url, body }) => window.callApi(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { url: resourceUrl, body: item }
      );
      expect(response.status).toBe(201);
    }

    const result = await page.evaluate(
      (url) => window.callApi(`${url}?category=user&page=1&size=1`),
      resourceUrl
    );
    expect(result).toMatchObject({ blocked: false, status: 200 });
    expect(result.headers["x-total-count"]).toBe("2");
    expect(result.body).toEqual([{ id: "b", name: "Beta", category: "USER" }]);
  });

  test("un conflitto seed resta sanitizzato nel mock ma diagnosticabile nel Monitor", async ({ page, request }) => {
    await page.evaluate((url) => window.callApi(url), resourceUrl);
    const conflict = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/shared-items-conflict`
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: "Shared State Conflict",
      code: "SHARED_STATE_SEED_CONFLICT",
    });
    expect(JSON.stringify(conflict.body)).not.toContain("shared-items");
    expect(JSON.stringify(conflict.body)).not.toContain("@v2");

    const monitoredResponse = await request.get(
      `${stack.mockxyBaseUrl}/_admin/api/monitoring/requests`
    );
    expect(monitoredResponse.status()).toBe(200);
    const monitored = (await monitoredResponse.json()).items.find(
      (entry) => entry.path === "/shared-items-conflict"
    );
    expect(monitored.sharedStateError).toMatchObject({
      code: "SHARED_STATE_SEED_CONFLICT",
      name: "shared-items",
      requestedSeedKey: "shared-items@v2",
      currentSeedKey: "shared-items@v1",
    });
  });

  test("il reset rifiuta zero byte e accetta soltanto JSON {}", async ({ request }) => {
    const missingBody = await request.post(resetUrl);
    expect(missingBody.status()).toBe(415);

    const zeroBytes = await request.post(resetUrl, {
      headers: { "content-type": "application/json", "content-length": "0" },
      data: "",
    });
    expect(zeroBytes.status()).toBe(400);

    const valid = await request.post(resetUrl, { data: {} });
    expect(valid.status()).toBe(200);
  });
});
