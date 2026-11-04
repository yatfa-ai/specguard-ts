import Reporter from "../../dist/vitest/reporter.js";

// Freezes `vitest.config` so SpecguardVitestReporter#onInit cannot flip
// `includeTaskLocation`. Test fixture only.
export default class FrozenConfigReporter extends Reporter {
  onInit(vitest) {
    try {
      Object.freeze(vitest.config);
    } catch {}
    super.onInit(vitest);
  }
}
