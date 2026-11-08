// Same as jest.config.mjs, scoped to the multi-line `.each` fixture so the
// unfiltered runs of jest.config.mjs never see it.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/multiline-each.test.js"],
  reporters: ["default", "<rootDir>/dist/jest/reporter.js"],
  testLocationInResults: true,
};
