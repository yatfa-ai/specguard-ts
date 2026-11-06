// Runs every hook-failure fixture beside the healthy mixed one, so the tests
// can assert one failed row per affected file AND the healthy rows intact.
export default {
  test: {
    include: [
      "fixtures/vitest/mixed.test.ts",
      "fixtures/vitest/hook-describe-afterall.test.ts",
      "fixtures/vitest/hook-before-all.test.ts",
      "fixtures/vitest/hook-top-afterall.test.ts",
      "fixtures/vitest/hook-with-failing-test.test.ts",
    ],
    includeTaskLocation: true,
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
