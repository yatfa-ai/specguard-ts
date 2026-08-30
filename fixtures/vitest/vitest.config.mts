// The WITH-REPORTER config the Vitest integration tests run: the default
// reporter plus this package's built reporter, with the one Vitest setting
// the wire contract depends on (`includeTaskLocation`). Reported by path so
// the run exercises the same default-export instantiation a consumer's
// `reporters: ["default", "specguard-ts/vitest"]` goes through.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts", "fixtures/vitest/annotated.test.ts"],
    includeTaskLocation: true,
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
