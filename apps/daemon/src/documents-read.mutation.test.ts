// Mutation twin for the seam-read gate: it replicates the gate's Zod round-trip
// and feeds it a record with a REQUIRED field dropped (the shape a hard-coded /
// short-circuiting read route would emit) — asserting `.parse()` throws (so the
// gate would redden). A complete, canonical record is the green control that
// proves the assertion is not always-firing.

import { describe, expect, test } from "vitest";

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

interface ParsableSchema {
  readonly parse: (value: unknown) => unknown;
}

// A complete row in the canonical `documents` shape (ULID id, snake_case fields,
// ISO-8601 timestamps).
const completeRow = (): Record<string, unknown> => ({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: "seam-read",
  body_preview: "",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe("the seam-read gate rejects a row that drops a required field", () => {
  test("a record missing a required field fails documentSchema.parse — the gate would redden", async () => {
    const dbMod = await dyn("@perry-starter/db");
    const documentSchema = dbMod.documentSchema as ParsableSchema;

    // A short-circuiting/stub read would emit a row with a required field
    // dropped — build it without `title` (no mutation of a complete row).
    const broken: Record<string, unknown> = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      body_preview: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(() => documentSchema.parse(broken)).toThrow();
  });

  test("a complete canonical row parses cleanly (not always-firing)", async () => {
    const dbMod = await dyn("@perry-starter/db");
    const documentSchema = dbMod.documentSchema as ParsableSchema;

    expect(() => documentSchema.parse(completeRow())).not.toThrow();
  });
});
