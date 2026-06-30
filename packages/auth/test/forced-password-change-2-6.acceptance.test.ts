// Acceptance suite (RED phase) — the forced-password-change gate + the
// new-password acceptance policy (NIST 800-63B length-only + HIBP breach
// screening that FAILS OPEN on outage).
//
// Every test is `test.skip(...)`: the dev un-skips per behavior once the pure
// decision modules land. Top-level imports are limited to vitest; every
// not-yet-existing module is reached ONLY inside a skipped body via dynamic
// `await import(...)`, so `vitest run` collects this file with zero import
// errors.
//
// The decisions under test are PURE functions of injected inputs — no ambient
// session, no wall clock, no live HIBP call. The Worker host binds them to the
// real tRPC middleware / session / range API.

import { describe, expect, test } from "vitest";

const CHANGE_PASSWORD_PATH = "auth.changePassword";
const FORBIDDEN_HTTP_STATUS = 403;
const REQUIRE_CHANGE_HEADER = "x-require-password-change";

// A representative spread of non-change-password paths a flagged user might hit.
const OTHER_PATHS = [
  "documents.list",
  "documents.read",
  "documents.create",
  "organization.setActive",
  "auth.getSession",
] as const;

const loadGate = async () =>
  (await import("@perry-starter/auth/forced-password-change")) as unknown as {
    evaluateForcedPasswordChange: (input: {
      requirePasswordChange: boolean;
      path: string;
    }) =>
      | { allow: true }
      | {
          allow: false;
          httpStatus: number;
          code: string;
          signalHeader: string;
        };
  };

const loadPolicy = async () =>
  (await import("@perry-starter/auth/password-policy")) as unknown as {
    validatePasswordPolicy: (
      pw: string
    ) => { ok: true } | { ok: false; reason: string };
    resolveBreachScreen: (input: {
      hibp: "clean" | "compromised" | "unreachable";
    }) => { accept: boolean; audit?: string };
  };

// The audit action vocabulary the canonical AuditEntry enforces:
// `^(auth|admin|session|lockout|user)\.[a-z][a-z0-9_]*$`.
const AUDIT_ACTION = /^(auth|admin|session|lockout|user)\.[a-z][a-z0-9_]*$/;

describe("the forced-password-change gate blocks everything except change-password", () => {
  test("an unflagged account is allowed on every path", async () => {
    const { evaluateForcedPasswordChange } = await loadGate();
    for (const path of [CHANGE_PASSWORD_PATH, ...OTHER_PATHS]) {
      expect(
        evaluateForcedPasswordChange({ requirePasswordChange: false, path })
      ).toEqual({ allow: true });
    }
  });

  test("a flagged account is allowed on the change-password path — its one forward path", async () => {
    const { evaluateForcedPasswordChange } = await loadGate();
    expect(
      evaluateForcedPasswordChange({
        requirePasswordChange: true,
        path: CHANGE_PASSWORD_PATH,
      })
    ).toEqual({ allow: true });
  });

  test("a flagged account is denied on every other path with 403 + the require-password-change signal header", async () => {
    const { evaluateForcedPasswordChange } = await loadGate();
    for (const path of OTHER_PATHS) {
      const verdict = evaluateForcedPasswordChange({
        requirePasswordChange: true,
        path,
      });
      expect(verdict.allow).toBe(false);
      if (verdict.allow === false) {
        expect(verdict.httpStatus).toBe(FORBIDDEN_HTTP_STATUS);
        // Carried in the error envelope's data.code, not a native tRPC code.
        expect(verdict.code).toBe("PASSWORD_CHANGE_REQUIRED");
        expect(verdict.signalHeader).toBe(REQUIRE_CHANGE_HEADER);
      }
    }
  });
});

describe("a new password is accepted only when NIST-valid and not breach-blocked, and HIBP fails open", () => {
  test("the length window is 12–128 characters at the boundaries (11 reject, 12/128 accept, 129 reject)", async () => {
    const { validatePasswordPolicy } = await loadPolicy();
    expect(validatePasswordPolicy("a".repeat(11)).ok).toBe(false);
    expect(validatePasswordPolicy("a".repeat(12)).ok).toBe(true);
    expect(validatePasswordPolicy("a".repeat(128)).ok).toBe(true);
    expect(validatePasswordPolicy("a".repeat(129)).ok).toBe(false);
  });

  test("there is no composition rule — a 12-char all-lowercase passphrase with no digit, symbol, or uppercase is accepted", async () => {
    const { validatePasswordPolicy } = await loadPolicy();
    // Would be rejected by any composition/complexity gate; NIST 800-63B forbids
    // exactly such rules, so this MUST pass.
    expect(validatePasswordPolicy("correcthorse").ok).toBe(true);
  });

  test("HIBP unreachable fails OPEN — a NIST-valid password is accepted and the fallback is recorded as an audit event", async () => {
    const { resolveBreachScreen } = await loadPolicy();
    const clean = resolveBreachScreen({ hibp: "clean" });
    expect(clean.accept).toBe(true);
    expect(clean.audit).toBeUndefined();

    const compromised = resolveBreachScreen({ hibp: "compromised" });
    expect(compromised.accept).toBe(false);

    const unreachable = resolveBreachScreen({ hibp: "unreachable" });
    expect(unreachable.accept).toBe(true); // fail OPEN — never bricks forced change
    expect(unreachable.audit).toMatch(AUDIT_ACTION); // the fallback is audited
  });

  test("the breach-screen fallback still enforces the NIST policy — HIBP unreachable plus a too-short password is rejected", async () => {
    const { validatePasswordPolicy, resolveBreachScreen } = await loadPolicy();
    // Acceptance requires policy.ok AND breachScreen.accept. The fail-open path
    // never relaxes the length floor.
    const policy = validatePasswordPolicy("a".repeat(8));
    const breach = resolveBreachScreen({ hibp: "unreachable" });
    const accepted = policy.ok && breach.accept;
    expect(accepted).toBe(false);
  });
});
