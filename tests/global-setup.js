const stack = require("./stack");

// Verifica che lo stack docker compose sia su prima di lanciare i test, con un errore
// azionabile invece di una pioggia di timeout.
async function assertReachable(url, label) {
  try {
    await fetch(url);
  } catch (_error) {
    throw new Error(
      `${label} non raggiungibile su ${url}. Lo stack è su? Avvialo con: npm run stack:up`
    );
  }
}

module.exports = async function globalSetup() {
  await assertReachable(stack.clientPageUrl, "La pagina client (nginx)");
  await assertReachable(`${stack.mockxyBaseUrl}/hello`, "Mockxy (istanza CORS)");
  await assertReachable(`${stack.mockxyRawBaseUrl}/hello`, "Mockxy (istanza raw)");
  await assertReachable(`${stack.mockxyDevBaseUrl}/watched`, "Mockxy (istanza dev con watch)");
  await assertReachable(`${stack.mockxyToggleBaseUrl}/hello`, "Mockxy (istanza commutabile)");
  await assertReachable(`${stack.mockxyDelayBaseUrl}/hello`, "Mockxy (istanza con ritardo)");
  await assertReachable(
    `${stack.mockxySequenceAdminBaseUrl}/sequence-admin`,
    "Mockxy (istanza sequence amministrabile)"
  );
  await assertReachable(
    `${stack.mockxyDiscoveryBaseUrl}/agent-ready`,
    "Mockxy (istanza della discovery amministrativa)"
  );
  await assertReachable(
    `${stack.mockxyStreamBaseUrl}/stream-other`,
    "Mockxy (istanza di sviluppo per gli stream durante i reload)"
  );
  await assertReachable(
    `${stack.mockxySetupBaseUrl}/agent-ready`,
    "Mockxy (istanza dello scenario ripetibile via API)"
  );
};
