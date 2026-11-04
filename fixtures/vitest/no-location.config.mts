// The NO-LOCATION config: identical to vitest.config.mts minus
// `includeTaskLocation` — Vitest's default. The reporter enables the option
// itself in `onInit`, so this run still POSTs rows with correct line numbers.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts"],
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
