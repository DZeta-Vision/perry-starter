import { describe, expect, test } from "vitest";
import { documentsEntitySchema } from "../documents";
import { auditEntrySchema } from "../shapes/audit-entry";
import { deltaEnvelopeSchema } from "../shapes/delta-envelope";
import { documentProjectionSchema } from "../shapes/document-projection";

const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

const keysOf = (schema: { shape: Record<string, unknown> }): string[] =>
  Object.keys(schema.shape);

const keyedShapes = [
  deltaEnvelopeSchema,
  documentProjectionSchema,
  auditEntrySchema,
  documentsEntitySchema,
];

describe("canonical shape naming conventions", () => {
  test("every field key on every canonical shape is snake_case", () => {
    for (const schema of keyedShapes) {
      const keys = keysOf(schema);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(SNAKE_CASE_KEY.test(key)).toBe(true);
      }
    }
  });

  test("the client-minted id validates as a ULID and the timestamp as ISO-8601", () => {
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
    expect(auditEntrySchema.safeParse(base).success).toBe(true);
  });
});
