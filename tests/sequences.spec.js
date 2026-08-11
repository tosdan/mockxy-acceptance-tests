const { test, expect } = require("@playwright/test");
const stack = require("./stack");

async function mockIdForPath(request, mockPath, baseUrl = stack.mockxyBaseUrl) {
  const response = await request.get(`${baseUrl}/_admin/api/mocks`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  const item = catalog.items.find((candidate) => candidate.path === mockPath);
  expect(item, `endpoint ${mockPath} non trovato nel catalogo admin`).toBeTruthy();
  return item.id;
}

async function mockDetail(request, baseUrl, mockId) {
  const response = await request.get(`${baseUrl}/_admin/api/mocks/${mockId}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function resetSequence(request, baseUrl, mockId) {
  const response = await request.post(`${baseUrl}/_admin/api/mocks/${mockId}/sequence/reset`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function selectResponse(request, baseUrl, mockId, responseFileName) {
  const response = await request.put(`${baseUrl}/_admin/api/mocks/${mockId}`, {
    data: { selectedResponseFile: responseFileName },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function createSequence(request, mockId, overrides = {}) {
  const response = await request.post(
    `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${mockId}/responses`,
    {
      data: {
        type: "sequence",
        title: "Polling",
        steps: [
          { response: "001.response.json", times: 2 },
          { response: "002.response.json" },
        ],
        onEnd: "stay",
        ...overrides,
      },
    }
  );
  expect(response.status()).toBe(201);
  return response.json();
}

async function cleanupWritableScenario(request, mockId) {
  let detail = await mockDetail(request, stack.mockxySequenceAdminBaseUrl, mockId);
  if (detail.selectedResponseFile !== "001.response.json") {
    detail = await selectResponse(
      request,
      stack.mockxySequenceAdminBaseUrl,
      mockId,
      "001.response.json"
    );
  }
  for (const response of detail.responses.filter((candidate) => candidate.type === "sequence")) {
    const deleted = await request.delete(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${mockId}/responses/${encodeURIComponent(response.fileName)}`
    );
    expect(deleted.status()).toBe(200);
  }
}

async function readStatus(request, baseUrl, routePath) {
  const response = await request.get(`${baseUrl}${routePath}`);
  expect(response.status()).toBe(200);
  return response.json();
}

// Il cursore è stato runtime condiviso dell'istanza. Tutti gli scenari girano una volta sola,
// in serie su Chromium, e ripristinano esplicitamente sia i cursori sia l'istanza CRUD in tmpfs.
test.describe("sequence come variante di response attraverso il container", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: una sola esecuzione (project chromium)"
  );

  let jobId;
  let writableId;

  test.beforeEach(async ({ request }) => {
    jobId = await mockIdForPath(request, "/job-status");
    await resetSequence(request, stack.mockxyBaseUrl, jobId);
    writableId = await mockIdForPath(
      request,
      "/sequence-admin",
      stack.mockxySequenceAdminBaseUrl
    );
    await cleanupWritableScenario(request, writableId);
  });

  test.afterEach(async ({ request }) => {
    if (writableId) {
      await cleanupWritableScenario(request, writableId);
    }
  });

  test("la fixture selezionata avanza per times e resta sullo step terminale", async ({ request }) => {
    expect((await readStatus(request, stack.mockxyBaseUrl, "/job-status")).status).toBe("processing");
    expect((await readStatus(request, stack.mockxyBaseUrl, "/job-status")).status).toBe("processing");
    expect((await readStatus(request, stack.mockxyBaseUrl, "/job-status")).status).toBe("completed");
    expect((await readStatus(request, stack.mockxyBaseUrl, "/job-status")).status).toBe("completed");
  });

  test("state e reset dell'admin API operano sulla response sequence selezionata", async ({ request }) => {
    await readStatus(request, stack.mockxyBaseUrl, "/job-status");
    await readStatus(request, stack.mockxyBaseUrl, "/job-status");
    await readStatus(request, stack.mockxyBaseUrl, "/job-status");

    const stateResponse = await request.get(
      `${stack.mockxyBaseUrl}/_admin/api/mocks/${jobId}/sequence/state`
    );
    expect(stateResponse.status()).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      sequenceFile: "003.response.json",
      sequenceState: { stepIndex: 1, servedInStep: 1 },
    });

    const reset = await resetSequence(request, stack.mockxyBaseUrl, jobId);
    expect(reset).toMatchObject({
      sequenceFile: "003.response.json",
      sequenceState: { stepIndex: 0, servedInStep: 0 },
    });
    expect((await readStatus(request, stack.mockxyBaseUrl, "/job-status")).status).toBe("processing");
  });

  test("il dettaglio espone la sequence dalla response, non dal file endpoint", async ({ request }) => {
    const detail = await mockDetail(request, stack.mockxyBaseUrl, jobId);

    expect(detail.type).toBe("sequence");
    expect(detail.selectedResponseFile).toBe("003.response.json");
    expect(detail.endpoint).not.toHaveProperty("sequence");
    expect(detail.sequence).toMatchObject({
      onEnd: "stay",
      steps: [{ response: "001.response.json", times: 2 }, { response: "002.response.json" }],
    });
    expect(detail.sequenceState).toMatchObject({ stepIndex: 0, servedInStep: 0 });
  });

  test("forMs e onEnd loop restano osservabili dall'immagine standalone", async ({ request }) => {
    const phaseId = await mockIdForPath(request, "/phase");
    await resetSequence(request, stack.mockxyBaseUrl, phaseId);

    expect((await readStatus(request, stack.mockxyBaseUrl, "/phase")).phase).toBe("uno");
    expect((await readStatus(request, stack.mockxyBaseUrl, "/phase")).phase).toBe("uno");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await readStatus(request, stack.mockxyBaseUrl, "/phase")).phase).toBe("due");
    expect((await readStatus(request, stack.mockxyBaseUrl, "/phase")).phase).toBe("uno");
  });

  test("create seleziona la sequence; reset e selezione ordinaria la disattivano correttamente", async ({ request }) => {
    const created = await createSequence(request, writableId);
    const sequenceFile = created.selectedResponseFile;

    expect(created.type).toBe("sequence");
    expect(created.endpoint).not.toHaveProperty("sequence");
    expect(created.responses.find((response) => response.fileName === sequenceFile)?.type).toBe("sequence");
    expect((await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin")).status)
      .toBe("processing");
    expect((await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin")).status)
      .toBe("processing");
    expect((await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin")).status)
      .toBe("completed");

    const reset = await resetSequence(request, stack.mockxySequenceAdminBaseUrl, writableId);
    expect(reset.sequenceFile).toBe(sequenceFile);
    expect(reset.sequenceState).toMatchObject({ stepIndex: 0, servedInStep: 0 });

    await selectResponse(
      request,
      stack.mockxySequenceAdminBaseUrl,
      writableId,
      "001.response.json"
    );
    expect((await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin")).status)
      .toBe("processing");
    const inactiveState = await request.get(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/sequence/state`
    );
    expect(inactiveState.status()).toBe(400);
    const catalog = await (
      await request.get(`${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks`)
    ).json();
    expect(catalog.items.find((item) => item.id === writableId).sequenceActive).toBe(false);
  });

  test("più sequence hanno cursori distinti e proteggono i target condivisi", async ({ request }) => {
    const first = await createSequence(request, writableId, { title: "Prima" });
    const firstFile = first.selectedResponseFile;
    await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin");

    await selectResponse(request, stack.mockxySequenceAdminBaseUrl, writableId, "001.response.json");
    const second = await createSequence(request, writableId, {
      title: "Seconda",
      steps: [
        { response: "002.response.json", times: 1 },
        { response: "001.response.json" },
      ],
    });
    const secondFile = second.selectedResponseFile;

    await selectResponse(request, stack.mockxySequenceAdminBaseUrl, writableId, firstFile);
    let state = await request.get(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/sequence/state`
    );
    expect((await state.json()).sequenceState).toMatchObject({ stepIndex: 0, servedInStep: 0 });
    await readStatus(request, stack.mockxySequenceAdminBaseUrl, "/sequence-admin");
    await selectResponse(request, stack.mockxySequenceAdminBaseUrl, writableId, secondFile);
    await selectResponse(request, stack.mockxySequenceAdminBaseUrl, writableId, firstFile);
    state = await request.get(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/sequence/state`
    );
    expect((await state.json()).sequenceState).toMatchObject({ stepIndex: 0, servedInStep: 0 });

    await selectResponse(request, stack.mockxySequenceAdminBaseUrl, writableId, "001.response.json");
    const blocked = await request.delete(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/responses/001.response.json`
    );
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).details.referencedBy).toEqual([firstFile, secondFile]);

    const deletedFirst = await request.delete(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/responses/${encodeURIComponent(firstFile)}`
    );
    expect(deletedFirst.status()).toBe(200);
    const stillBlocked = await request.delete(
      `${stack.mockxySequenceAdminBaseUrl}/_admin/api/mocks/${writableId}/responses/001.response.json`
    );
    expect(stillBlocked.status()).toBe(409);
    expect((await stillBlocked.json()).details.referencedBy).toEqual([secondFile]);
  });
});
