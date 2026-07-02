import { describe, expect, test } from "vitest";

import {
  isAuthSuccess,
  isCredentialFailure,
  normalizeAccountSubject,
} from "./login-outcome";

describe("normalizeAccountSubject canonicalizes the per-account key", () => {
  test("casing and surrounding whitespace collapse to one canonical subject", () => {
    const canonical = "alice@example.com";
    expect(normalizeAccountSubject("  Alice@Example.com ")).toBe(canonical);
    expect(normalizeAccountSubject("ALICE@EXAMPLE.COM")).toBe(canonical);
    expect(normalizeAccountSubject("alice@example.com")).toBe(canonical);
  });

  test("distinct identities stay distinct after normalization", () => {
    expect(normalizeAccountSubject("a@example.com")).not.toBe(
      normalizeAccountSubject("b@example.com")
    );
  });
});

describe("isCredentialFailure gates ONLY the genuine credential miss", () => {
  test("a 401 (invalid credentials) is a lockout strike", () => {
    expect(isCredentialFailure(401)).toBe(true);
  });

  test("a 403 (verification-required, correct password) is NOT a strike", () => {
    expect(isCredentialFailure(403)).toBe(false);
  });

  test("neither a success (200) nor a malformed request (400) is a strike", () => {
    expect(isCredentialFailure(200)).toBe(false);
    expect(isCredentialFailure(400)).toBe(false);
    expect(isCredentialFailure(429)).toBe(false);
    expect(isCredentialFailure(500)).toBe(false);
  });
});

describe("isAuthSuccess recognizes only a 2xx sign-in", () => {
  test("any 2xx is a success (clears the ladder)", () => {
    expect(isAuthSuccess(200)).toBe(true);
    expect(isAuthSuccess(204)).toBe(true);
  });

  test("a 3xx/4xx/5xx is not a success", () => {
    expect(isAuthSuccess(302)).toBe(false);
    expect(isAuthSuccess(401)).toBe(false);
    expect(isAuthSuccess(403)).toBe(false);
    expect(isAuthSuccess(500)).toBe(false);
  });
});
