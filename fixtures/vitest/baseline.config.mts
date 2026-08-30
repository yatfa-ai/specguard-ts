// The BASELINE config for the never-fail exit-code parity test: identical
// to vitest.config.mts minus the SpecGuard reporter. Nothing about the runs
// differs except the reporter, so exit codes and the default reporter's
// output must match the with-reporter run modulo timing and one stderr line.
export default {
  test: {
    include: ["fixtures/vitest/mixed.test.ts", "fixtures/vitest/annotated.test.ts"],
    includeTaskLocation: true,
    reporters: ["default"],
  },
};
