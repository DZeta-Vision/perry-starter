import { describe, expect, test } from "vitest";
import { collaborationModeSchema } from "../collaboration-mode";
import { documentsEntitySchema } from "../documents";
import { auditEntrySchema } from "../shapes/audit-entry";
import { deltaEnvelopeSchema } from "../shapes/delta-envelope";
import { documentProjectionSchema } from "../shapes/document-projection";

const isRuntimeValidator = (candidate: unknown): boolean => {
  const shape = candidate as { parse?: unknown; safeParse?: unknown } | null;
  return (
    typeof shape?.parse === "function" && typeof shape?.safeParse === "function"
  );
};

const canonicalShapes = [
  deltaEnvelopeSchema,
  documentProjectionSchema,
  auditEntrySchema,
  collaborationModeSchema,
  documentsEntitySchema,
];

describe("canonical shapes are hand-authored runtime Zod", () => {
  test("every canonical shape exposes runtime parse and safeParse", () => {
    for (const shape of canonicalShapes) {
      expect(isRuntimeValidator(shape)).toBe(true);
    }
  });
});
