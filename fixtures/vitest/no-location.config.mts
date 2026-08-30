// The NO-LOCATION config: identical to vitest.config.mts minus
// `includeTaskLocation` — the measured state where Vitest hands every test
// `location: null`, so every row is dropped with one warning and nothing
// POSTs. Pins that the config knob is load-bearing, not decorative.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts"],
    reporters: ["default", "./dist/vitest/reporter.js"],
  },
};
