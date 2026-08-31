// The BASELINE config for the never-fail exit-code parity test: identical
// to jest.config.mjs minus the SpecGuard reporter. Nothing about the runs
// differs except the reporter, so exit codes and the default reporter's
// output must match the with-reporter run modulo timing and one stderr line.
export default {
  rootDir: "../..",
  testMatch: ["<rootDir>/fixtures/jest/mixed.test.js", "<rootDir>/fixtures/jest/annotated.test.js"],
  testLocationInResults: true,
  reporters: ["default"],
};
