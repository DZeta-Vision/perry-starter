import { describe, expect, test } from "vitest";

// A source line wiring a generated typegen artifact as a source of truth.
const TYPEGEN_IMPORT = /from\s+["'][^"']*(?:surrealkit|typegen)[^"']*["']/i;

const isRuntimeValidator = (candidate: unknown): boolean => {
  const shape = candidate as { parse?: unknown; safeParse?: unknown } | null;
  return (
    typeof shape?.parse === "function" && typeof shape?.safeParse === "function"
  );
};

describe("the runtime-validator and round-trip checks reject non-Zod stand-ins", () => {
  test("a bare object literal (TypeScript-interface stand-in) is rejected", () => {
    const interfaceStandIn = { doc_id: "string", scope_user_id: "string" };
    expect(isRuntimeValidator(interfaceStandIn)).toBe(false);
    expect(isRuntimeValidator({})).toBe(false);
    expect(isRuntimeValidator(null)).toBe(false);
  });

  test("a stand-in with a fake parse passes the existence check but fails the round-trip", () => {
    // A non-validator that merely exposes `.parse`/`.safeParse` echoes a
    // constant, ignoring its input — so a valid fixture does NOT survive parse.
    const fakeValidator = {
      parse: (_input: unknown) => ({ tampered: true }),
      safeParse: (_input: unknown) => ({ success: true }),
    };
    const fixture = { doc_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Untitled" };
    // The shallow existence check cannot tell it apart from a real validator.
    expect(isRuntimeValidator(fakeValidator)).toBe(true);
    // The round-trip assertion the gate now performs catches it.
    expect(fakeValidator.parse(fixture)).not.toEqual(fixture);
  });

  test("the typegen-import guard fires on a planted generated-typegen import line", () => {
    expect(
      TYPEGEN_IMPORT.test(
        'import type { Doc } from "../generated/surrealkit-typegen";'
      )
    ).toBe(true);
    expect(TYPEGEN_IMPORT.test('import { Schema } from "./db.typegen";')).toBe(
      true
    );
    // A hand-authored zod import must NOT trip the guard (not always-true).
    expect(TYPEGEN_IMPORT.test('import { z } from "zod";')).toBe(false);
  });
});
