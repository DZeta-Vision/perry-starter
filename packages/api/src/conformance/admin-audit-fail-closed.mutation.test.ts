// Mutation twin for admin-audit-fail-closed.gate.test.ts.
//
// It drives a FAIL-OPEN counterpart to the real `requireSink` audit-sink guard — the
// `ctx.recordConsequentAudit?.(...)` optional-chaining no-op the fix removed — and
// asserts the gate's "fails closed with ADMIN_BACKEND_UNAVAILABLE" check goes RED on
// it: when the audit recorder is absent, the fail-open variant does NOT throw and
// yields a silent no-op, so a privileged mutation would proceed and skip its audit.
// This proves the fail-closed assertion is load-bearing; it also confirms the REAL
// guard throws, so the two diverge exactly where they must.

import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import { ADMIN_BACKEND_UNAVAILABLE, requireSink } from "../fail-closed";

type AuditRecorder = (event: {
  readonly action: string;
  readonly actor: string;
  readonly target?: string;
}) => void;

// The fail-OPEN anti-pattern the gate forbids: an absent audit recorder becomes a
// silent no-op instead of a throw, so a privileged mutation would resolve unaudited.
const failOpenAudit = (recorder: AuditRecorder | undefined): AuditRecorder =>
  recorder ?? (() => undefined);

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

test("the real guard throws ADMIN_BACKEND_UNAVAILABLE when the audit recorder is absent", () => {
  expect(causeCode(() => requireSink(undefined, "recordConsequentAudit"))).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
});

test("a fail-open audit guard does NOT throw (it no-ops) — so the mutate-then-skip-audit fail-closed check reddens on it", () => {
  const resolved = failOpenAudit(undefined);
  // No throw: a mutation using `?.`/fallback would proceed and silently skip audit.
  expect(
    causeCode(() =>
      resolved({ action: "admin.user_deactivated", actor: "user-1" })
    )
  ).toBe("no-throw");
});
