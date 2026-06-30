import { describe, expect, test } from "vitest";

import {
  AUTH_ERROR_CODES,
  authCodeFromEnvelope,
  treatmentForCode,
} from "./auth-error";

describe("the 8-state AuthErrorResponse machine maps each code to exactly one treatment", () => {
  test("every one of the eight codes resolves to a defined treatment (a total map, none unmapped)", () => {
    expect(AUTH_ERROR_CODES).toHaveLength(8);
    for (const code of AUTH_ERROR_CODES) {
      expect(treatmentForCode(code)).toBeTruthy();
    }
  });

  test("the eight codes resolve to eight mutually-distinct treatments (none collapsed to a shared screen)", () => {
    const treatments = new Set(AUTH_ERROR_CODES.map(treatmentForCode));
    expect(treatments.size).toBe(AUTH_ERROR_CODES.length);
  });

  test("each code maps to its one specified treatment", () => {
    expect(treatmentForCode("UNAUTHORIZED")).toBe("sign-in");
    expect(treatmentForCode("SESSION_EXPIRED")).toBe("session-expired");
    expect(treatmentForCode("EMAIL_NOT_VERIFIED")).toBe("verify-email");
    expect(treatmentForCode("PASSWORD_CHANGE_REQUIRED")).toBe(
      "forced-password-change"
    );
    expect(treatmentForCode("TWO_FACTOR_REQUIRED")).toBe("two-factor");
    expect(treatmentForCode("STEP_UP_REQUIRED")).toBe("step-up");
    expect(treatmentForCode("ACCOUNT_LOCKED")).toBe("account-locked");
    expect(treatmentForCode("FORBIDDEN")).toBe("no-access");
  });
});

describe("the envelope parser reads the precise code a server issues", () => {
  test("reads the code from a nested error envelope", () => {
    expect(
      authCodeFromEnvelope({ body: { error: { code: "FORBIDDEN" } } })
    ).toBe("FORBIDDEN");
  });

  test("reads a bare top-level code", () => {
    expect(authCodeFromEnvelope({ body: { code: "ACCOUNT_LOCKED" } })).toBe(
      "ACCOUNT_LOCKED"
    );
  });

  test("the require-password-change header forces the forced-change code even over a FORBIDDEN body", () => {
    expect(
      authCodeFromEnvelope({
        headers: { "x-require-password-change": "1" },
        body: { error: { code: "FORBIDDEN" } },
      })
    ).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  test("reads the require-password-change header from a Headers instance", () => {
    expect(
      authCodeFromEnvelope({
        headers: new Headers({ "x-require-password-change": "1" }),
      })
    ).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  test("an unrecognized payload yields undefined so the caller falls back to generic, never inventing a code", () => {
    expect(
      authCodeFromEnvelope({ body: { error: { code: "INVALID_EMAIL" } } })
    ).toBeUndefined();
    expect(authCodeFromEnvelope({})).toBeUndefined();
  });
});
