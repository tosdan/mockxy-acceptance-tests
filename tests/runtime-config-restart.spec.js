const { execFileSync } = require("child_process");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");
const { adminJson, adminSend } = require("./admin-client");

// Il riavvio elimina gli override della configurazione effimera (piano agent/API, §13 C8): nuovo
// runtimeId, overrides vuoti ed effective uguale a startup; il vecchio cursore del Monitor
// segnala runtime_changed. Riavvia un container: gira nel project chromium-config-restart, dopo
// tutti gli altri e mai in concorrenza (vedi playwright.config.js).

const BASE = stack.mockxyConfigBaseUrl;
const COMPOSE_DIR = path.join(__dirname, "..");
const SERVICE = "mockxy-config";
const RESTART_TIMEOUT_MS = 60000;

async function waitForNewRuntime(request, previousRuntimeId) {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await request.get(`${BASE}/_admin/api/info`, { timeout: 2000 });
      if (response.ok()) {
        const info = await response.json();
        if (info.runtimeId !== previousRuntimeId) {
          return info;
        }
      }
    } catch {
      /* container in riavvio: si riprova */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${SERVICE} non è tornato con un nuovo runtimeId entro ${RESTART_TIMEOUT_MS} ms`);
}

test.describe("riavvio della configurazione effimera", () => {
  test("il riavvio elimina gli override e il vecchio cursore del Monitor segnala runtime_changed", async ({ page, request }) => {
    const before = await adminJson(request, BASE, "/info");
    const overridden = await adminSend(request, BASE, "PATCH", "/config", {
      set: { backendUrl: "http://backend-b:9000", corsEnabled: false, globalDelayMs: 50 },
    });
    expect(Object.keys(overridden.overrides).sort()).toEqual(["backendUrl", "corsEnabled", "globalDelayMs"]);
    const cursor = (await adminJson(request, BASE, "/monitoring/requests?view=page&since=latest")).cursor;
    expect(cursor.runtimeId).toBe(before.runtimeId);

    execFileSync("docker", ["compose", "restart", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" });
    const after = await waitForNewRuntime(request, before.runtimeId);

    const config = await adminJson(request, BASE, "/config");
    expect(config.runtimeId).toBe(after.runtimeId);
    expect(config.overrides).toEqual({});
    expect(config.effective).toEqual(config.startup);
    expect(config.startup).toEqual(overridden.startup);
    expect(config.persisted).toBe(false);
    expect(after.revisions.config).toBe(1);

    // Il traffico nuovo usa di nuovo la configurazione di avvio: backend "a" e CORS attivo.
    await page.goto("/");
    const served = await page.evaluate((url) => window.callApi(url), `${BASE}/identity/dopo-il-riavvio-${Date.now()}`);
    expect(served).toMatchObject({ blocked: false, status: 200, body: { backend: "a" } });

    const query = new URLSearchParams({ view: "page", since: cursor.since, runtimeId: cursor.runtimeId, generation: String(cursor.generation) });
    const page1 = await adminJson(request, BASE, `/monitoring/requests?${query}`);
    expect(page1).toMatchObject({ gap: true, gapReason: "runtime_changed" });
    expect(page1.cursor.runtimeId).toBe(after.runtimeId);
  });
});
