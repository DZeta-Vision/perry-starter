// Acceptance suite — AuditEntry canonical shape.
//
// The full normative field set, a lowercase `<domain>.<verb>` action vocabulary,
// a ULID id, and an ISO-8601 timestamp.
//
// The shape is imported dynamically; top-level imports are limited to vitest.

import { describe, expect, test } from "vitest";

const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TARGET_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ACTOR_ID = "01J0XQT8Z9N3H6K2M5P7R9T1V3";

// Canonical AuditEntry — full normative field set, lowercase <domain>.<verb>
// action (domain ∈ {auth, admin, session, lockout, user}), ULID id, ISO-8601 ts.
const canonicalAudit = () => ({
  id: ID_A,
  action: "auth.sign_in",
  actor: ACTOR_ID,
  actor_email: "person@example.com",
  actor_role: "member",
  target_type: "session",
  target_id: TARGET_ID,
  metadata: { reason: "password" },
  ip: "127.0.0.1",
  user_agent: "Mozilla/5.0",
  timestamp: "2026-06-28T12:00:00.000Z",
});

const importAudit = async () => {
  const mod = await import("@perry-starter/db/shapes/audit-entry");
  return mod.auditEntrySchema;
};

describe("AuditEntry canonical shape", () => {
  test("the canonical audit entry parses with the full field set, a domain.verb action, ULID id, and ISO timestamp", async () => {
    const auditEntrySchema = await importAudit();
    expect(auditEntrySchema.safeParse(canonicalAudit()).success).toBe(true);
    // Every allowed domain in the vocabulary parses.
    for (const domain of ["auth", "admin", "session", "lockout", "user"]) {
      expect(
        auditEntrySchema.safeParse({
          ...canonicalAudit(),
          action: `${domain}.created`,
        }).success
      ).toBe(true);
    }
  });

  test("a missing actor_email is rejected", async () => {
    const auditEntrySchema = await importAudit();
    const { actor_email, ...withoutEmail } = canonicalAudit();
    expect(actor_email).toBe("person@example.com");
    expect(auditEntrySchema.safeParse(withoutEmail).success).toBe(false);
  });

  test("a missing timestamp is rejected", async () => {
    const auditEntrySchema = await importAudit();
    const { timestamp, ...withoutTimestamp } = canonicalAudit();
    expect(timestamp).toBe("2026-06-28T12:00:00.000Z");
    expect(auditEntrySchema.safeParse(withoutTimestamp).success).toBe(false);
  });

  test("a non-ISO timestamp is rejected", async () => {
    const auditEntrySchema = await importAudit();
    expect(
      auditEntrySchema.safeParse({
        ...canonicalAudit(),
        timestamp: "28/06/2026 12:00",
      }).success
    ).toBe(false);
  });

  test("an uppercase-domain action and an unknown-domain action are rejected", async () => {
    const auditEntrySchema = await importAudit();
    // Uppercase domain violates the lowercase <domain>.<verb> convention.
    expect(
      auditEntrySchema.safeParse({ ...canonicalAudit(), action: "Auth.signIn" })
        .success
    ).toBe(false);
    // Unknown domain outside {auth, admin, session, lockout, user}.
    expect(
      auditEntrySchema.safeParse({
        ...canonicalAudit(),
        action: "billing.charge",
      }).success
    ).toBe(false);
  });

  test("a drifted field (renamed required field) is rejected", async () => {
    const auditEntrySchema = await importAudit();
    const { actor_role, ...renamed } = canonicalAudit();
    expect(actor_role).toBe("member");
    expect(
      auditEntrySchema.safeParse({ ...renamed, actorRole: "member" }).success
    ).toBe(false);
  });
});
