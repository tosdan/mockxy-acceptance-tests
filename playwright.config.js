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
  // dei browser: la suite gira su tutti e tre. I test stateful (hot reload, cache preflight)
  // si autolimitano a chromium: mutano stato condiviso (container, file) e i project
  // girano in parallelo.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
