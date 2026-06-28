// Intentionally-bad fixture for the tier-boundary guard self-test. It pulls a
// DENYLISTED cloud/WASM dependency into the daemon / seam graph — the dependency
// the guard must flag (the daemon graph carries no in-process WASM/prebuilt-JS).
// Excluded from typecheck and the build; the denylisted package is not installed
// and exists here only as static text the guard reads. Never imported by real
// code.
import { PGlite } from "@electric-sql/pglite";

export const forbidden = PGlite;
