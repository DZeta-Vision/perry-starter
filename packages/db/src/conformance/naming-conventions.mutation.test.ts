import { describe, expect, test } from "vitest";
import { auditEntrySchema } from "../shapes/audit-entry";

const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

describe("naming-convention checks reject violations", () => {
  test("the snake_case asserter flags camelCase keys and accepts snake_case", () => {
    expect(SNAKE_CASE_KEY.test("docId")).toBe(false);
    expect(SNAKE_CASE_KEY.test("updatedCursor")).toBe(false);
    expect(SNAKE_CASE_KEY.test("doc_id")).toBe(true);
    expect(SNAKE_CASE_KEY.test("updated_cursor")).toBe(true);
  });

  test("a non-ISO timestamp and a non-ULID id are rejected by their validators", () => {
    const base = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      action: "auth.sign_in",
      actor: "01J0XQT8Z9N3H6K2M5P7R9T1V3",
      actor_email: "person@example.com",
      actor_role: "member",
      target_type: "session",
      target_id: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
      metadata: {},
      ip: "127.0.0.1",
      user_agent: "Mozilla/5.0",
      timestamp: "2026-06-28T12:00:00.000Z",
    };
    expect(
      auditEntrySchema.safeParse({ ...base, timestamp: "yesterday" }).success
    ).toBe(false);
    expect(
      auditEntrySchema.safeParse({ ...base, id: "not-a-ulid" }).success
    ).toBe(false);
  });
});
