// The FALLBACK config: no `includeTaskLocation`, and a reporter wrapper that
// freezes the resolved Vitest config before the real reporter's `onInit`, so
// the reporter cannot enable the option. Exercises the dropped-rows warning.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts"],
    reporters: ["default", "./fixtures/vitest/frozen-config-reporter.mjs"],
  },
};
