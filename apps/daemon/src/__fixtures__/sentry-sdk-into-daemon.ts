// Intentionally-bad fixture for the tier-boundary guard self-test. It pulls an
// in-process Sentry SDK into the daemon graph — the import the guard must flag
// (the daemon's Sentry path is a hand-rolled envelope over native fetch, never an
// in-process SDK). Excluded from typecheck and the build; the SDK is not resolved
// here and this exists only as static text the guard reads. Never imported by real
// code.
import { init } from "@sentry/node";

export const forbidden = init;
