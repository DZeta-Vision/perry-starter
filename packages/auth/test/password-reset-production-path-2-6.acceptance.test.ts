// Acceptance — the password-reset security guarantees proven on the REAL ingress
// (better-auth `auth.handler` over an in-memory adapter, wrapped by the
// production `normalizeAuthResponse`), never a synthetic double:
//
//   - the reset-REQUEST surface is byte-identical across the email-state matrix
//     and reuses the ONE canonical neutral envelope (anti-enumeration);
//   - a reset token is SINGLE-USE — once a reset completes, replaying the same
//     token is rejected (better-auth consumes/deletes the verification record);
//   - the reset-token identifier is stored HASHED at rest, never the plaintext
//     token — yet a valid token still resets and a replay is still rejected;
//   - issuing a NEW reset token invalidates any PRIOR outstanding one — the first
//     token is rejected and only the latest works;
//   - a successful reset revokes ALL of the user's sessions (a session minted
//     before the reset no longer resolves);
//   - the new password is HIBP-screened on the `newPassword` field — a breached
//     newPassword is rejected when the range API is reachable, and the SAME
//     password is accepted (fail-OPEN) with an audit event when it is unreachable,
//     so an HIBP outage never bricks the only-unblocked action.

import { createHash } from "node:crypto";
import {
  createTestAuthority,
  resetAuthHarness,
  resetRequestNormalized,
  resetRequestRaw,
  seedEmailMatrix,
} from "@perry-starter/auth/test-harness";
import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// The reset-token identifier better-auth persists: `reset-password:<token>`.
const resetIdentifier = (token: string): string => `reset-password:${token}`;

// How better-auth hashes a stored identifier under `storeIdentifier: "hashed"`:
// base64url(SHA-256(identifier)), no padding. Node's "base64url" digest encoding
// is byte-identical to better-auth's `base64Url.encode(..., { padding: false })`.
const hashedIdentifier = (token: string): string =>
  createHash("sha256")
    .update(resetIdentifier(token), "utf8")
    .digest("base64url");

const HTTP_OK = 200;
// The fixture the reachable HIBP double reports as breached (12 chars — NIST-valid
// on length, so it reaches the breach screen rather than the length gate).
const BREACHED_PASSWORD = "password1234";
const VALID_PASSWORD = "correct horse battery";
const FRESH_PASSWORD = "fresh staple unicorn";
const SECOND_PASSWORD = "another distinct phrase";

const EMAIL_STATES = [
  "registered-verified",
  "registered-unverified",
  "registered-pending",
  "unregistered",
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

const envelopeSurface: SurfaceResponse = {
  body: neutralAuthEnvelope.body,
  headers: { ...neutralAuthEnvelope.headers },
  status: neutralAuthEnvelope.status,
};

afterEach(() => {
  resetAuthHarness();
});

describe("the reset-request surface reveals neither existence nor verification state", () => {
  beforeEach(async () => {
    await seedEmailMatrix([...EMAIL_STATES]);
  });

  test("every email state yields one byte-identical normalized response", async () => {
    const fingerprints = new Set<string>();
    for (const state of EMAIL_STATES) {
      const surface = await resetRequestNormalized(
        `${state}@matrix.example.com`
      );
      fingerprints.add(canonicalize(surface));
    }
    expect(fingerprints.size).toBe(1);
  });

  test("the normalized reset-request response reuses the one canonical neutral envelope", async () => {
    const registered = await resetRequestNormalized(
      "registered-verified@matrix.example.com"
    );
    expect(canonicalize(registered)).toBe(canonicalize(envelopeSurface));
  });

  test("the normalizer is load-bearing — the raw better-auth surface is not the canonical envelope", async () => {
    const raw = await resetRequestRaw("registered-verified@matrix.example.com");
    const normalized = await resetRequestNormalized(
      "registered-verified@matrix.example.com"
    );
    expect(canonicalize(raw)).not.toBe(canonicalize(normalized));
    expect(canonicalize(normalized)).toBe(canonicalize(envelopeSurface));
  });
});

describe("a reset token is single-use and a successful reset revokes every session", () => {
  test("replaying a consumed reset token is rejected", async () => {
    const authority = createTestAuthority();
    const email = "single-use@example.com";
    await authority.signUp({ email, password: VALID_PASSWORD });
    const verifyToken = authority.sentEmails().at(-1)?.variables
      .verifyToken as string;
    await authority.verifyEmail(verifyToken);

    const { token } = await authority.requestPasswordReset(email);
    expect(token).toBeTruthy();

    const first = await authority.resetPassword({
      newPassword: FRESH_PASSWORD,
      token: token as string,
    });
    expect(first.status).toBe(HTTP_OK);

    // The SAME token a second time — the verification record was consumed, so the
    // replay finds nothing and is rejected.
    const replay = await authority.resetPassword({
      newPassword: SECOND_PASSWORD,
      token: token as string,
    });
    expect(replay.status).not.toBe(HTTP_OK);
  });

  test("a session minted before the reset no longer resolves after it", async () => {
    const authority = createTestAuthority();
    const email = "revoke-all@example.com";
    await authority.signUp({ email, password: VALID_PASSWORD });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );
    const session = await authority.signIn({ email, password: VALID_PASSWORD });
    expect(session.token).toBeTruthy();

    const { token } = await authority.requestPasswordReset(email);
    const completed = await authority.resetPassword({
      newPassword: FRESH_PASSWORD,
      token: token as string,
    });
    expect(completed.status).toBe(HTTP_OK);

    const after = await authority.getSession(session.token as string);
    expect((after as { user?: unknown } | null)?.user).toBeFalsy();
  });
});

describe("the new password is HIBP-screened on the newPassword field and fails open on an outage", () => {
  test("a breached newPassword is rejected when the range API is reachable", async () => {
    const authority = createTestAuthority();
    const email = "hibp-reachable@example.com";
    await authority.signUp({ email, password: VALID_PASSWORD });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );
    const { token } = await authority.requestPasswordReset(email);
    const attempt = await authority.resetPassword({
      newPassword: BREACHED_PASSWORD,
      token: token as string,
    });
    expect(attempt.status).not.toBe(HTTP_OK);
    expect(JSON.stringify(attempt.body)).toContain("PASSWORD_COMPROMISED");
  });

  test("the same breached newPassword is accepted with an audit event when the range API is unreachable", async () => {
    const authority = createTestAuthority();
    const email = "hibp-unreachable@example.com";
    await authority.signUp({ email, password: VALID_PASSWORD });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );
    const { token } = await authority.requestPasswordReset(email);
    const accepted = await authority.withUnreachableHibp(() =>
      authority.resetPassword({
        newPassword: BREACHED_PASSWORD,
        token: token as string,
      })
    );
    expect(accepted.status).toBe(HTTP_OK);
    expect(authority.auditActions()).toContain("auth.hibp_fallback");
  });
});

describe("the reset-token identifier is hashed at rest, never the plaintext token", () => {
  test("the persisted verification identifier is the hash, not the raw token, yet a valid token still resets and a replay is rejected", async () => {
    const authority = createTestAuthority();
    const email = "hash-at-rest@example.com";
    const account = await authority.signUp({
      email,
      password: VALID_PASSWORD,
    });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );

    const { token } = await authority.requestPasswordReset(email);
    expect(token).toBeTruthy();
    const rawToken = token as string;

    // Inspect what is actually persisted, BEFORE the token is consumed.
    const rows = authority.verificationRows();
    const identifiers = rows.map((row) => String(row.identifier));

    // The plaintext identifier is NEVER at rest…
    expect(identifiers).not.toContain(resetIdentifier(rawToken));
    // …nor is the raw token embedded anywhere in a stored identifier…
    expect(identifiers.some((id) => id.includes(rawToken))).toBe(false);
    // …the token is persisted ONLY as its base64url SHA-256 hash.
    expect(identifiers).toContain(hashedIdentifier(rawToken));
    // The hashed row still carries the user id as its value (the reset target).
    const hashedRow = rows.find(
      (row) => row.identifier === hashedIdentifier(rawToken)
    );
    expect(hashedRow?.value).toBe(account.userId);

    // The hashed lookup works: a valid token still resets.
    const first = await authority.resetPassword({
      newPassword: FRESH_PASSWORD,
      token: rawToken,
    });
    expect(first.status).toBe(HTTP_OK);

    // Single-use is preserved under hashing — the replay is rejected.
    const replay = await authority.resetPassword({
      newPassword: SECOND_PASSWORD,
      token: rawToken,
    });
    expect(replay.status).not.toBe(HTTP_OK);
  });
});

describe("issuing a new reset token invalidates any prior outstanding one", () => {
  test("after a second reset request the first token is rejected and only the latest works", async () => {
    const authority = createTestAuthority();
    const email = "prior-invalidation@example.com";
    await authority.signUp({ email, password: VALID_PASSWORD });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );

    const firstToken = (await authority.requestPasswordReset(email))
      .token as string;
    const secondToken = (await authority.requestPasswordReset(email))
      .token as string;
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);

    // The prior token was invalidated the moment the new one was issued.
    const staleAttempt = await authority.resetPassword({
      newPassword: FRESH_PASSWORD,
      token: firstToken,
    });
    expect(staleAttempt.status).not.toBe(HTTP_OK);

    // Only the latest token resets.
    const latest = await authority.resetPassword({
      newPassword: SECOND_PASSWORD,
      token: secondToken,
    });
    expect(latest.status).toBe(HTTP_OK);
  });
});
