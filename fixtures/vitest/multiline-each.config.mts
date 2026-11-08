// Same as vitest.config.mts, scoped to the multi-line `.each` fixture so the
// unfiltered runs of vitest.config.mts never see it.
export default {
  test: {
    include: ["fixtures/vitest/multiline-each.test.ts"],
    includeTaskLocation: true,
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
