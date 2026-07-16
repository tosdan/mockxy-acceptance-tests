const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// L':id admin è opaco (base64url del percorso del file endpoint): si ricava dal
// catalogo cercando il path, senza replicarne la codifica nei test.
async function mockIdForPath(request, mockPath) {
  const response = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  const item = catalog.items.find((candidate) => candidate.path === mockPath);
  expect(item, `endpoint ${mockPath} non trovato nel catalogo admin`).toBeTruthy();
  return item.id;
}

async function resetSequence(request, mockId) {
  const response = await request.post(
    `${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}/sequence/reset`
  );
  expect(response.status()).toBe(200);
  return response.json();
}

async function jobStatus(request) {
  const response = await request.get(`${stack.mockxyBaseUrl}/job-status`);
  expect(response.status()).toBe(200);
  return (await response.json()).status;
}

// La sequenza di varianti vista da fuori: /job-status dichiara due step
// (001 "processing" per 2 richieste, poi 002 "completed" come stato terminale, onEnd stay).
// Il cursore è stato runtime CONDIVISO dell'istanza: i test girano una volta sola
// (project chromium) e in serie, con un reset esplicito in testa a ogni test.
test.describe("sequenza di varianti attraverso il container", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: una sola esecuzione (project chromium)"
  );

  let mockId;

  test.beforeEach(async ({ request }) => {
    mockId = await mockIdForPath(request, "/job-status");
    await resetSequence(request, mockId);
  });

  test("gli step rispondono nell'ordine dichiarato e l'ultimo è terminale", async ({ request }) => {
    // Step 1: times=2 → le prime due richieste vedono "processing".
    expect(await jobStatus(request)).toBe("processing");
    expect(await jobStatus(request)).toBe("processing");

    // Step 2 senza criterio + onEnd stay → da qui in poi sempre "completed".
    expect(await jobStatus(request)).toBe("completed");
    expect(await jobStatus(request)).toBe("completed");
    expect(await jobStatus(request)).toBe("completed");
  });

  test("il reset dall'admin API riparte dal primo step", async ({ request }) => {
    // Si consuma la sequenza fino allo stato terminale...
    await jobStatus(request);
    await jobStatus(request);
    expect(await jobStatus(request)).toBe("completed");

    // ...e il reset esplicito riporta il cursore in testa: come una nuova sessione di prova.
    await resetSequence(request, mockId);
    expect(await jobStatus(request)).toBe("processing");
  });

  test("il dettaglio admin espone la definizione della sequenza", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/_admin/api/mocks/${mockId}`);
    expect(response.status()).toBe(200);
    const detail = await response.json();

    // La definizione arriva dal file endpoint montato nel container...
    expect(detail.endpoint.sequence).toMatchObject({
      enabled: true,
      onEnd: "stay",
      steps: [{ response: "001.response.json", times: 2 }, { response: "002.response.json" }],
    });
    // ...e il cursore runtime è esposto accanto (azzerato dal beforeEach).
    expect(detail.sequenceState).toBeTruthy();
  });
});
