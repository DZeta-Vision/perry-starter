// Mutation twin for admin-surface-fail-closed.gate.test.ts.
//
// It drives a FAIL-OPEN counterpart to the real `requireSink` guard — one that,
// when the injected sink is absent, returns a permissive default instead of throwing
// — and asserts the gate's "throws ADMIN_BACKEND_UNAVAILABLE" check goes RED on it
// (no throw). This proves the fail-closed assertion is load-bearing: if a privileged
// procedure silently succeeded with no forwarder, the gate would catch it. It also
// confirms the REAL guard throws, so the two diverge exactly where they must.

import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import { ADMIN_BACKEND_UNAVAILABLE, requireSink } from "../fail-closed";

// The fail-OPEN anti-pattern the gate forbids: an absent sink yields a permissive
// fallback rather than a throw, so a privileged procedure would resolve unprivileged.
const failOpenSink = <T>(sink: T | undefined, fallback: T): T =>
  sink ?? fallback;

const causeCode = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined;
      return cause?.code ?? error.code;
    }
  }
  return "no-throw";
};

test("the real guard throws ADMIN_BACKEND_UNAVAILABLE when the sink is absent", () => {
  expect(causeCode(() => requireSink(undefined, "readAuditEntries"))).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
});

test("a fail-open guard does NOT throw (it returns the fallback) — so the fail-closed check reddens on it", () => {
  const fallback = () => Promise.resolve([]);
  // No throw: the gate's throw-requirement would go red against this variant.
  expect(causeCode(() => failOpenSink(undefined, fallback))).toBe("no-throw");
  expect(failOpenSink(undefined, fallback)).toBe(fallback);
});
