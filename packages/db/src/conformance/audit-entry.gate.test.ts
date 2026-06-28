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

describe("audit entry canonical shape", () => {
  test("the full field set with a domain.verb action, ULID id and ISO timestamp parses", () => {
    expect(auditEntrySchema.safeParse(canonical()).success).toBe(true);
  });

  test("every allowed action domain parses", () => {
    for (const domain of ["auth", "admin", "session", "lockout", "user"]) {
      expect(
        auditEntrySchema.safeParse({
          ...canonical(),
          action: `${domain}.created`,
        }).success
      ).toBe(true);
    }
  });
});
