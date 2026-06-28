// Intentionally-bad fixture for the tier-boundary guard self-test. It pulls a
// DENYLISTED in-process WASM dependency into the daemon graph — the import the
// guard must flag (the daemon reaches every engine over loopback HTTP, never an
// in-process SDK/WASM). Excluded from typecheck and the build; the denylisted
// package is not installed and exists here only as static text the guard reads.
// Never imported by real code.
import { Surreal } from "@surrealdb/wasm";

export const forbidden = Surreal;
