import { describe, expect, test } from "vitest";
import { auditEntrySchema } from "../shapes/audit-entry";

const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TARGET_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ACTOR_ID = "01J0XQT8Z9N3H6K2M5P7R9T1V3";

const canonical = () => ({
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

describe("audit entry rejects known-bad input", () => {
  test("a missing actor_email is rejected", () => {
    const { actor_email, ...withoutEmail } = canonical();
    expect(actor_email).toBe("person@example.com");
    expect(auditEntrySchema.safeParse(withoutEmail).success).toBe(false);
  });

  test("a missing timestamp and a non-ISO timestamp are rejected", () => {
    const { timestamp, ...withoutTimestamp } = canonical();
    expect(timestamp).toBe("2026-06-28T12:00:00.000Z");
    expect(auditEntrySchema.safeParse(withoutTimestamp).success).toBe(false);
    expect(
      auditEntrySchema.safeParse({
        ...canonical(),
        timestamp: "28/06/2026 12:00",
      }).success
    ).toBe(false);
  });

  test("an uppercase-domain action and an unknown-domain action are rejected", () => {
    expect(
      auditEntrySchema.safeParse({ ...canonical(), action: "Auth.signIn" })
        .success
    ).toBe(false);
    expect(
      auditEntrySchema.safeParse({ ...canonical(), action: "billing.charge" })
        .success
    ).toBe(false);
  });

  test("a drifted (renamed required) field is rejected", () => {
    const { actor_role, ...renamed } = canonical();
    expect(actor_role).toBe("member");
    expect(
      auditEntrySchema.safeParse({ ...renamed, actorRole: "member" }).success
    ).toBe(false);
  });
});
