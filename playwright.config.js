const { defineConfig, devices } = require("@playwright/test");
const stack = require("./tests/stack");

module.exports = defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.js",
  fullyParallel: true,
  reporter: [["list"]],
  // Un solo retry, e solo in CI: i runner condivisi sono più rumorosi di una macchina di
  // sviluppo (asserzioni temporali su latenza/SSE/timeout); in locale la flakiness deve
  // restare visibile.
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: stack.clientPageUrl,
  },
  // Le semantiche sotto test (CORS, cookie, preflight, SSE) divergono davvero tra i motori
  // dei browser: la suite gira su tutti e tre. I test stateful si autolimitano a chromium:
  // mutano stato condiviso (container, file) e i project girano in parallelo.
  //
  // preflight-cache è un gradino oltre lo stateful: RICREA un container via docker compose,
  // e la riconfigurazione di rete di Docker può resettare per un attimo le connessioni verso
  // le ALTRE istanze pubblicate (ECONNRESET visto in CI sui test concorrenti, retry incluso
  // perché ricadeva nella stessa finestra). Va quindi in un project dedicato che parte solo
  // quando i tre project browser hanno finito: mai concorrente con nessuno.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /preflight-cache/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: /preflight-cache/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: /preflight-cache/ },
    {
      name: "chromium-stack-mutating",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /preflight-cache/,
      dependencies: ["chromium", "firefox", "webkit"],
    },
  ],
});
