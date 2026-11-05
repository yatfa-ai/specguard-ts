// Runs the crashing suite beside the mixed one, so the tests can assert the
// crash ships as one failed row AND the surviving suite's rows are intact.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/mixed.test.js", "<rootDir>/fixtures/jest/crash.test.js"],
  reporters: ["default", "<rootDir>/dist/jest/reporter.js"],
  testLocationInResults: true,
};
