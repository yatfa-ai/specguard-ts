// Deliberately fails to LOAD: a top-level throw before any test is declared.
// Vitest reports the module as failed with zero tests and a module error.
throw new Error("boom at import");
