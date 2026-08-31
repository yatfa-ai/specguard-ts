// The WITH-REPORTER config the Jest integration tests run: the default
// reporter plus this package's built reporter, with the one Jest setting
// the wire contract depends on (`testLocationInResults`). Reported by
// path so the run exercises the same default-export instantiation a
// consumer's `reporters: ["default", "specguard-ts/jest"]` goes through.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/mixed.test.js", "<rootDir>/fixtures/jest/annotated.test.js"],
  reporters: ["default", "<rootDir>/dist/jest/reporter.js"],
  testLocationInResults: true,
};
