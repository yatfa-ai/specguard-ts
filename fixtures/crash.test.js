// Deliberately fails to LOAD: a top-level throw before any test is declared.
// The runner reports the file itself as failed; the reporter must ship that
// as one failed row rather than dropping the file.
throw new Error("boom at import");
