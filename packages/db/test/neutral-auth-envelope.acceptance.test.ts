// Acceptance — the cross-surface anti-enumeration invariant, driven on the REAL
// ingress.
//
// The one canonical neutral envelope is single-sourced in packages/db and reused by
// the production worker normalizer that wraps `auth.handler`. Across the five-state
// email matrix (registered / unregistered / verified / unverified / pending) the
// post-submit response on sign-up and verification-resend must be byte-identical in
// status, body, and headers — never confirming or denying that an email exists or
// its state. EMAIL_NOT_VERIFIED must be unreachable on these pre-auth surfaces.
//
// The matrix is materialized as REAL divergent accounts behind the surfaces and the
// surfaces are driven through the production `auth.handler` + `normalizeAuthResponse`
// (NOT a synthetic double). The neutral-envelope module and the auth surfaces are
// imported dynamically (packages/db carries no build-graph dependency on the auth
// tier; the test runner resolves the specifiers). The pure detectors are real, so
// the anti-vacuous direction is provable without the implementation.

import { describe, expect, test } from "vitest";

// ── The five-state pre-auth email matrix ───────────────────────────────────────
const EMAIL_MATRIX = [
  "registered",
  "unregistered",
  "verified",
  "unverified",
  "pending",
] as const;

interface SurfaceResponse {
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

const canonicalize = (response: SurfaceResponse): string => {
  const headerEntries = Object.entries(response.headers)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    body: response.body,
    headers: headerEntries,
    status: response.status,
  });
};

const allByteIdentical = (responses: SurfaceResponse[]): boolean => {
  if (responses.length === 0) {
    return false; // a vacuous (empty) matrix must not pass
  }
  const first = canonicalize(responses[0]);
  return responses.every((r) => canonicalize(r) === first);
};

const revealsExistenceOrState = (value: unknown): boolean => {
  const serialized = JSON.stringify(value ?? null).toUpperCase();
  return (
    serialized.includes("EMAIL_NOT_VERIFIED") ||
    serialized.includes("ALREADY") ||
    serialized.includes("NOT FOUND") ||
    serialized.includes("UNREGISTERED") ||
    serialized.includes("EXISTS")
  );
};

const loadPreAuthSurfaces = async () => {
  const mod = await import("@perry-starter/auth/test-harness");
  return {
    resendVerification: mod.resendVerification as (
      email: string
    ) => Promise<SurfaceResponse>,
    signUp: mod.signUp as (email: string) => Promise<SurfaceResponse>,
  };
};

const seedMatrixFixtures = async () => {
  const mod = await import("@perry-starter/auth/test-harness");
  return mod.seedEmailMatrix([...EMAIL_MATRIX]) as Promise<
    Record<string, string>
  >;
};

const neutralResponseSubpath = ["auth", "neutral-response"].join("/");
const loadNeutralEnvelope = async (): Promise<SurfaceResponse> => {
  const mod = await import(`@perry-starter/db/${neutralResponseSubpath}`);
  return mod.neutralAuthEnvelope as SurfaceResponse;
};

// ──────────────────────────────────────────────────────────────────────────────
describe("canonical neutral auth envelope is single-sourced in packages/db", () => {
  test("the neutral envelope is a frozen status/body/headers shape", async () => {
    const envelope = await loadNeutralEnvelope();
    expect(typeof envelope.status).toBe("number");
    expect(envelope.body).toBeDefined();
    expect(envelope.headers).toBeDefined();
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  test("the neutral envelope never confirms or denies email existence or state", async () => {
    const envelope = await loadNeutralEnvelope();
    expect(revealsExistenceOrState(envelope.body)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("sign-up is byte-identical across the five-state email matrix", () => {
  test("status, body, and headers are identical for every email state", async () => {
    const { signUp } = await loadPreAuthSurfaces();
    const fixtures = await seedMatrixFixtures();
    const responses: SurfaceResponse[] = [];
    for (const state of EMAIL_MATRIX) {
      responses.push(await signUp(fixtures[state]));
    }
    expect(allByteIdentical(responses)).toBe(true);
  });

  test("each sign-up response equals the single packages/db neutral envelope", async () => {
    const { signUp } = await loadPreAuthSurfaces();
    const envelope = await loadNeutralEnvelope();
    const fixtures = await seedMatrixFixtures();
    for (const state of EMAIL_MATRIX) {
      const response = await signUp(fixtures[state]);
      expect(response.status).toBe(envelope.status);
      expect(response.body).toEqual(envelope.body);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("verification-resend is byte-identical across the email matrix", () => {
  test("status, body, and headers are identical for every email state", async () => {
    const { resendVerification } = await loadPreAuthSurfaces();
    const fixtures = await seedMatrixFixtures();
    const responses: SurfaceResponse[] = [];
    for (const state of EMAIL_MATRIX) {
      responses.push(await resendVerification(fixtures[state]));
    }
    expect(allByteIdentical(responses)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("EMAIL_NOT_VERIFIED is unreachable on the pre-auth surfaces", () => {
  test("no pre-auth sign-up or resend response leaks EMAIL_NOT_VERIFIED or any state token", async () => {
    const { resendVerification, signUp } = await loadPreAuthSurfaces();
    const fixtures = await seedMatrixFixtures();
    for (const state of EMAIL_MATRIX) {
      const signUpResponse = await signUp(fixtures[state]);
      const resendResponse = await resendVerification(fixtures[state]);
      expect(revealsExistenceOrState(signUpResponse.body)).toBe(false);
      expect(revealsExistenceOrState(resendResponse.body)).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("the response-invariance check detects a revealing surface (anti-vacuous)", () => {
  const NEUTRAL: SurfaceResponse = {
    body: { message: "auth.verification.maybe_sent" },
    headers: { "content-type": "application/json" },
    status: 200,
  };

  test("a matrix where every surface reuses the neutral envelope passes", () => {
    const matrix = EMAIL_MATRIX.map(() => ({ ...NEUTRAL }));
    expect(allByteIdentical(matrix)).toBe(true);
  });

  test("a surface that diverges the body for the registered case fails the check", () => {
    const matrix = EMAIL_MATRIX.map((state) =>
      state === "registered"
        ? { ...NEUTRAL, body: { message: "auth.email.already_registered" } }
        : { ...NEUTRAL }
    );
    expect(allByteIdentical(matrix)).toBe(false);
  });

  test("a surface that diverges the status or a header fails the check", () => {
    const statusDrift = EMAIL_MATRIX.map((state) =>
      state === "unregistered" ? { ...NEUTRAL, status: 404 } : { ...NEUTRAL }
    );
    const headerDrift = EMAIL_MATRIX.map((state) =>
      state === "verified"
        ? {
            ...NEUTRAL,
            headers: { ...NEUTRAL.headers, "x-account-state": "verified" },
          }
        : { ...NEUTRAL }
    );
    expect(allByteIdentical(statusDrift)).toBe(false);
    expect(allByteIdentical(headerDrift)).toBe(false);
  });

  test("a leaked EMAIL_NOT_VERIFIED token in a pre-auth body is detected", () => {
    expect(revealsExistenceOrState({ code: "EMAIL_NOT_VERIFIED" })).toBe(true);
    expect(
      revealsExistenceOrState({ message: "auth.verification.maybe_sent" })
    ).toBe(false);
  });
});
