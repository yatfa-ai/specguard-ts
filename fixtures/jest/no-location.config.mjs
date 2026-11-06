// The NO-LOCATION config: identical to jest.config.mjs minus
// `testLocationInResults` — the measured state where Jest hands every test
// `location: null`, so the reporter derives each row's line from the suite's
// source and says so once. Pins that the knob changes where the line comes
// from (derived vs Jest's exact one), never whether rows ship.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/mixed.test.js"],
  reporters: ["default", "<rootDir>/dist/jest/reporter.js"],
};
