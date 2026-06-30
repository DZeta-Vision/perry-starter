// Acceptance — registration on the cloud better-auth authority, driven on the REAL
// ingress.
//
// Every proof drives the production `auth.handler` (over an isolated in-memory
// adapter) built from the SAME `buildAuthOptions` the shipped worker uses — same
// plugins, same fail-open breach-screen `before` hook, same registration/session
// hooks, same `auth.options`. There is no synthetic parallel layer: a config or
// hook regression reddens the relevant proof. Runs on the cloud/worker tier only,
// never the daemon.

import { personalOrgIdFor } from "@perry-starter/auth/personal-org";
import {
  createTestAuthority,
  resetAuthHarness,
} from "@perry-starter/auth/test-harness";
import { afterEach, describe, expect, test } from "vitest";

const VALID_PASSWORD_12 = "correct horse";
const VALID_PASSWORD_128 = "a".repeat(128);
const TOO_SHORT_PASSWORD_11 = "a".repeat(11);
const TOO_LONG_PASSWORD_129 = "a".repeat(129);
const ALL_LOWERCASE_NO_SYMBOL = "abcdefghijkl"; // 12 chars, no digit/symbol/upper
const KNOWN_BREACHED_PASSWORD = "password1234";
const ONE_HOUR_SECONDS = 3600;
const HTTP_OK = 200;

const lastVerifyToken = (
  sent: ReturnType<ReturnType<typeof createTestAuthority>["sentEmails"]>
): string => {
  const token = sent.at(-1)?.variables.verifyToken;
  if (typeof token !== "string") {
    throw new Error("no verification token was dispatched");
  }
  return token;
};

afterEach(() => {
  resetAuthHarness();
});

// ──────────────────────────────────────────────────────────────────────────────
describe("self sign-up creates a member, unverified, with a personal org owner", () => {
  test("a new account has global role member and emailVerified false", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "new@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(result.status).toBe(HTTP_OK);
    expect(result.role).toBe("member");
    expect(result.emailVerified).toBe(false);
  });

  test("sign-up auto-provisions a personal organization with the member as org owner", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "owner@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(result.orgRole).toBe("owner");
  });

  test("the personal org is persisted under the deterministic id the session derives", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "persisted-org@example.com",
      password: VALID_PASSWORD_12,
    });
    // The session resolves activeOrganizationId = personalOrgIdFor(userId); the
    // provisioned org row MUST carry that exact id, or the active org dangles.
    expect(
      harness.organizationById(personalOrgIdFor(result.userId ?? ""))
    ).not.toBeNull();
  });

  test("the org-structural owner role does not overwrite the global member role", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "orthogonal@example.com",
      password: VALID_PASSWORD_12,
    });
    // Two orthogonal namespaces — neither leaks into the other.
    expect(result.role).toBe("member");
    expect(result.role).not.toBe("owner");
    expect(result.orgRole).toBe("owner");
  });

  test("the personal org resolves as the active organization at the post-verify sign-in", async () => {
    const harness = createTestAuthority();
    const signUp = await harness.signUp({
      email: "active@example.com",
      password: VALID_PASSWORD_12,
    });
    await harness.verifyEmail(lastVerifyToken(harness.sentEmails()));
    const signIn = await harness.signIn({
      email: "active@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(signIn.token).toBeTruthy();
    const session = await harness.getSession(signIn.setAuthTokenHeader ?? "");
    expect(session.activeOrganizationId).toBe(
      personalOrgIdFor(signUp.userId ?? "")
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("password policy enforces NIST 800-63B length with no composition rule", () => {
  test("the configured length bounds are 12 and 128", () => {
    const harness = createTestAuthority();
    expect(harness.options.emailAndPassword?.minPasswordLength).toBe(12);
    expect(harness.options.emailAndPassword?.maxPasswordLength).toBe(128);
  });

  test("11 chars is rejected and 12 and 128 chars are accepted", async () => {
    const harness = createTestAuthority();
    const tooShort = await harness.signUp({
      email: "short@example.com",
      password: TOO_SHORT_PASSWORD_11,
    });
    expect(tooShort.status).not.toBe(HTTP_OK);
    const min = await harness.signUp({
      email: "min@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(min.status).toBe(HTTP_OK);
    const max = await harness.signUp({
      email: "max@example.com",
      password: VALID_PASSWORD_128,
    });
    expect(max.status).toBe(HTTP_OK);
  });

  test("129 chars is rejected", async () => {
    const harness = createTestAuthority();
    const tooLong = await harness.signUp({
      email: "long@example.com",
      password: TOO_LONG_PASSWORD_129,
    });
    expect(tooLong.status).not.toBe(HTTP_OK);
  });

  test("a 12-char all-lowercase passphrase is accepted (no composition rule)", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "nocomposition@example.com",
      password: ALL_LOWERCASE_NO_SYMBOL,
    });
    expect(result.status).toBe(HTTP_OK);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("HIBP k-anonymity screening on submit, failing open with an audit on outage", () => {
  test("a breached password is rejected when the range API is reachable", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "breached@example.com",
      password: KNOWN_BREACHED_PASSWORD,
    });
    expect(result.status).not.toBe(HTTP_OK);
  });

  test("when the HIBP range API is unreachable the account is still created (no 500)", async () => {
    const harness = createTestAuthority();
    const result = await harness.withUnreachableHibp(() =>
      harness.signUp({
        email: "outage@example.com",
        password: VALID_PASSWORD_12,
      })
    );
    expect(result.status).toBe(HTTP_OK);
    expect(result.emailVerified).toBe(false);
    expect(result.role).toBe("member");
  });

  test("the HIBP fail-open fallback emits an audit event on the production path", async () => {
    const harness = createTestAuthority();
    await harness.withUnreachableHibp(() =>
      harness.signUp({
        email: "outage-audit@example.com",
        password: VALID_PASSWORD_12,
      })
    );
    expect(harness.auditActions()).toContain("auth.hibp_fallback");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("a bilingual time-limited Resend verification email is dispatched", () => {
  test("the verification token TTL is one hour", () => {
    const harness = createTestAuthority();
    expect(harness.options.emailVerification?.expiresIn).toBe(ONE_HOUR_SECONDS);
  });

  test("a perry-verification email is dispatched in the account locale", async () => {
    const harness = createTestAuthority();
    await harness.signUp({
      email: "fr@example.com",
      locale: "fr",
      password: VALID_PASSWORD_12,
    });
    const sent = harness.sentEmails();
    expect(sent.at(-1)?.template).toBe("perry-verification");
    expect(sent.at(-1)?.locale).toBe("fr");
  });

  test("a simulated Resend send error is destructured and handled, never thrown", async () => {
    const harness = createTestAuthority();
    // The harness injects a Resend error result for this address; sign-up must not
    // reject on it (the send path destructures { data, error }).
    const result = await harness.signUp({
      email: "resend-error@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(result.status).toBe(HTTP_OK);
    expect(harness.sentEmails().some((email) => email.error !== null)).toBe(
      true
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("no usable session token is issued at registration", () => {
  test("registration is configured autoSignIn false with requireEmailVerification true", () => {
    const harness = createTestAuthority();
    expect(harness.options.emailAndPassword?.autoSignIn).toBe(false);
    expect(harness.options.emailAndPassword?.requireEmailVerification).toBe(
      true
    );
  });

  test("sign-up returns no session token, no set-auth-token header, and no session cookie", async () => {
    const harness = createTestAuthority();
    const result = await harness.signUp({
      email: "no-token@example.com",
      password: VALID_PASSWORD_12,
    });
    expect((result.body as { token?: unknown }).token ?? null).toBeNull();
    expect(result.setAuthTokenHeader).toBeNull();
    expect(result.setCookieHeader).toBeNull();
  });

  test("a usable session token is issued only at the post-verification sign-in", async () => {
    const harness = createTestAuthority();
    await harness.signUp({
      email: "post-verify@example.com",
      password: VALID_PASSWORD_12,
    });
    const preVerify = await harness.signIn({
      email: "post-verify@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(preVerify.token).toBeNull();
    await harness.verifyEmail(lastVerifyToken(harness.sentEmails()));
    const postVerify = await harness.signIn({
      email: "post-verify@example.com",
      password: VALID_PASSWORD_12,
    });
    expect(postVerify.token).toBeTruthy();
  });
});
