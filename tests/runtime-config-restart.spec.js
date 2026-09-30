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
const OVERRIDES = { backendUrl: "http://backend-b:9000", corsEnabled: false, globalDelayMs: 50 };

async function readInfo(request) {
  try {
    const response = await request.get(`${BASE}/_admin/api/info`, { timeout: 2000 });
    return response.ok() ? response.json() : null;
  } catch {
    return null; // container in riavvio
  }
}

/** Attende l'istanza raggiungibile, con un runtimeId diverso da `previousRuntimeId` se indicato. */
async function waitForRuntime(request, previousRuntimeId = null) {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await readInfo(request);
    if (info != null && info.runtimeId !== previousRuntimeId) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${SERVICE} non è raggiungibile${previousRuntimeId ? " con un nuovo runtimeId" : ""} entro ${RESTART_TIMEOUT_MS} ms`);
}

/**
 * Riporta l'istanza alla configurazione di avvio: attende che risponda (può essere a metà di un
 * riavvio, con un'attesa limitata) e toglie ogni override.
 */
async function restoreStartup(request) {
  await waitForRuntime(request);
  const current = await adminJson(request, BASE, "/config");
  const keys = Object.keys(current.overrides);
  const state = keys.length > 0 ? await adminSend(request, BASE, "PATCH", "/config", { unset: keys }) : current;
  expect(state.overrides).toEqual({});
  expect(state.effective).toEqual(state.startup);
}

/** Esegue `action` partendo dalla configurazione di avvio e ci torna anche se `action` fallisce. */
async function withStartupRestored(request, action) {
  await restoreStartup(request);
  try {
    return await action();
  } finally {
    await restoreStartup(request);
  }
}

async function applyOverrides(request) {
  const state = await adminSend(request, BASE, "PATCH", "/config", { set: OVERRIDES });
  expect(Object.keys(state.overrides).sort()).toEqual(Object.keys(OVERRIDES).sort());
  return state;
}

test.describe("riavvio della configurazione effimera", () => {
  // Due test sulla stessa istanza: in ordine, in un solo worker.
  test.describe.configure({ mode: "default" });

  test("un fallimento prima del riavvio non lascia override sull'istanza", async ({ request }) => {
    // Il caso riprodotto in review: override applicati, poi il comando Docker che fallisce.
    await expect(
      withStartupRestored(request, async () => {
        await applyOverrides(request);
        throw new Error("docker compose restart fallito (simulato)");
      })
    ).rejects.toThrow("simulato");

    const config = await adminJson(request, BASE, "/config");
    expect(config.overrides).toEqual({});
    expect(config.effective).toEqual(config.startup);
  });

  test("il riavvio elimina gli override e il vecchio cursore del Monitor segnala runtime_changed", async ({ page, request }) => {
    await withStartupRestored(request, async () => {
      const before = await adminJson(request, BASE, "/info");
      const overridden = await applyOverrides(request);
      const cursor = (await adminJson(request, BASE, "/monitoring/requests?view=page&since=latest")).cursor;
      expect(cursor.runtimeId).toBe(before.runtimeId);

      execFileSync("docker", ["compose", "restart", SERVICE], { cwd: COMPOSE_DIR, stdio: "ignore" });
      const after = await waitForRuntime(request, before.runtimeId);

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
      const monitorPage = await adminJson(request, BASE, `/monitoring/requests?${query}`);
      expect(monitorPage).toMatchObject({ gap: true, gapReason: "runtime_changed" });
      expect(monitorPage.cursor.runtimeId).toBe(after.runtimeId);
    });
  });
});
