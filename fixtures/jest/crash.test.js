// Deliberately fails to LOAD: a top-level throw before any test is declared.
// Jest reports the suite with an empty testResults and a testExecError.
throw new Error("boom at import");
