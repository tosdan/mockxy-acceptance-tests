// URL dello stack docker compose, condivise da configurazione e test (vedi docker-compose.yml).
module.exports = {
  clientPageUrl: "http://localhost:8081/",
  backendDirectBaseUrl: "http://localhost:9090",
  mockxyBaseUrl: "http://localhost:8080",
  mockxyRawBaseUrl: "http://localhost:8090",
  mockxyDevBaseUrl: "http://localhost:8070",
  mockxyToggleBaseUrl: "http://localhost:8060",
  mockxyDelayBaseUrl: "http://localhost:8050",
  mockxySequenceAdminBaseUrl: "http://localhost:8040",
  mockxyDiscoveryBaseUrl: "http://localhost:8030",
  mockxyStreamBaseUrl: "http://localhost:8020",
  mockxySetupBaseUrl: "http://localhost:8010",
};
