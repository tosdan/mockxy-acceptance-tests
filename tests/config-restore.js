const { expect } = require("@playwright/test");
const stack = require("./stack");
const { adminJson, adminSend } = require("./admin-client");

// Ripristino della configurazione di avvio di mockxy-config attorno ai test che la cambiano e
// riavviano il container. È negli hook, con un budget proprio: il ripristino può dover attendere
// un'istanza a metà di un riavvio più a lungo di quanto resti al test, anche dopo una scadenza.

const BASE = stack.mockxyConfigBaseUrl;
const SERVICE = "mockxy-config";
const RESTART_TIMEOUT_MS = 60000;
// Tempo aggiunto a ciascun hook: l'attesa massima dell'istanza più le due chiamate admin.
const RESTORE_BUDGET_MS = RESTART_TIMEOUT_MS + 15000;
const OVERRIDES = { backendUrl: "http://backend-b:9000", corsEnabled: false, globalDelayMs: 50 };
// Pausa dell'istanza nello spec interno dei fallimenti: più lunga del timeout del suo processo
// figlio (8 s, vedi config-restore-failure.config.js), che è anche il budget normale di un hook.
const FAILURE_PAUSE_MS = 20000;

async function readInfo(request) {
  try {
    const response = await request.get(`${BASE}/_admin/api/info`, { timeout: 2000 });
    return response.ok() ? response.json() : null;
  } catch {
    return null; // container in riavvio o in pausa
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

/** Attende che l'istanza risponda (con un limite) e toglie ogni override. */
async function restoreStartup(request) {
  await waitForRuntime(request);
  const current = await adminJson(request, BASE, "/config");
  const keys = Object.keys(current.overrides);
  const state = keys.length > 0 ? await adminSend(request, BASE, "PATCH", "/config", { unset: keys }) : current;
  expect(state.overrides).toEqual({});
  expect(state.effective).toEqual(state.startup);
}

/**
 * Registra la preparazione e il ripristino della configurazione di avvio. L'afterEach gira anche
 * dopo un fallimento o una scadenza del test, e ciascun hook si dà il budget dell'attesa invece di
 * dipendere dal tempo rimasto al test.
 */
function installStartupRestore(test) {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.setTimeout(testInfo.timeout + RESTORE_BUDGET_MS);
    await restoreStartup(request);
  });
  test.afterEach(async ({ request }, testInfo) => {
    testInfo.setTimeout(testInfo.timeout + RESTORE_BUDGET_MS);
    await restoreStartup(request);
  });
}

async function applyOverrides(request) {
  const state = await adminSend(request, BASE, "PATCH", "/config", { set: OVERRIDES });
  expect(Object.keys(state.overrides).sort()).toEqual(Object.keys(OVERRIDES).sort());
  return state;
}

module.exports = { BASE, SERVICE, OVERRIDES, FAILURE_PAUSE_MS, installStartupRestore, applyOverrides, waitForRuntime };
