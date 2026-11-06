// Runs every unhandled-error fixture beside the healthy mixed one, so the
// tests can assert one failed row per affected file AND the healthy rows intact.
export default {
  test: {
    include: [
      "fixtures/vitest/mixed.test.ts",
      "fixtures/vitest/unhandled-timer.test.ts",
      "fixtures/vitest/unhandled-rejection.test.ts",
      "fixtures/vitest/unhandled-with-failing-test.test.ts",
    ],
    includeTaskLocation: true,
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
