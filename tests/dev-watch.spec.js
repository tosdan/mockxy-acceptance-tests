const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const stack = require("./stack");

const RESPONSE_FILE_PATH = path.join(
  __dirname,
  "..",
  "workspace-watch",
  "mocks",
  "watched",
  "GET.responses",
  "001.response.json"
);

function buildResponsePayload(version) {
  return `${JSON.stringify(
    {
      type: "mock",
      status: 200,
      headers: { "content-type": "application/json" },
      delayMs: 0,
      body: { version },
    },
    null,
    2
  )}\n`;
}

async function pollUntilVersion(request, expectedVersion, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen;
  while (Date.now() < deadline) {
    const response = await request.get(`${stack.mockxyDevBaseUrl}/watched`);
    if (response.ok()) {
      lastSeen = await response.json();
      if (lastSeen.version === expectedVersion) {
        return lastSeen;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `il mock non ha raggiunto version=${expectedVersion} entro ${timeoutMs}ms (ultimo visto: ${JSON.stringify(lastSeen)})`
  );
}

// Hot reload nell'immagine di SVILUPPO: il test riscrive la response sul filesystem HOST e
// il watcher nel container (bind mount + polling) deve applicarla senza riavvii. Alla fine
// la fixture viene riportata alla versione 1, e si attende il reload di ritorno: così il
// test è idempotente e non lascia lo stack in uno stato diverso da come l'ha trovato.
test.describe("hot reload nel container di sviluppo", () => {
  // Test stateful (muta la fixture su disco condivisa tra i project): gira una volta sola.
  // È comunque a livello di request API: il browser non c'entra.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "stateful: una sola esecuzione (project chromium)"
  );

  test.afterEach(async ({ request }) => {
    fs.writeFileSync(RESPONSE_FILE_PATH, buildResponsePayload(1));
    await pollUntilVersion(request, 1);
  });

  test("una modifica al mock sul filesystem host viene ricaricata a caldo", async ({ request }) => {
    // Stato iniziale: la fixture committata.
    const initial = await request.get(`${stack.mockxyDevBaseUrl}/watched`);
    expect(initial.status()).toBe(200);
    expect(await initial.json()).toEqual({ version: 1 });

    // Modifica dal lato host: il container la vede solo attraverso il bind mount,
    // e senza polling il watcher non riceverebbe alcun evento.
    fs.writeFileSync(RESPONSE_FILE_PATH, buildResponsePayload(2));

    const reloaded = await pollUntilVersion(request, 2);
    expect(reloaded).toEqual({ version: 2 });
  });
});
