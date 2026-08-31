// The NO-LOCATION config: identical to jest.config.mjs minus
// `testLocationInResults` — the measured state where Jest hands every test
// `location: null`, so every row is dropped with one warning and nothing
// POSTs. Pins that the config knob is load-bearing, not decorative.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/mixed.test.js"],
  reporters: ["default", "<rootDir>/dist/jest/reporter.js"],
};
