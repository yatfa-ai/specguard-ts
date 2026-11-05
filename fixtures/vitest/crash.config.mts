// Runs the crashing module beside the mixed one, so the tests can assert the
// crash ships as one failed row AND the surviving module's rows are intact.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts", "fixtures/vitest/crash.test.ts"],
    includeTaskLocation: true,
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
