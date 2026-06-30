// Mutation twin for projection-single-writer.gate.test.ts. Introduces a SECOND
// writer and asserts the gate goes red:
//   - registering a second, different writer throws (single ownership);
//   - a second writer (e.g. the AI seam) touching a materialized column — the
//     embedding — throws (it may compute the embedding but never WRITES it).
//
// RED PHASE: every test is skipped until the surface is implemented.

import { describe, expect, test } from "vitest";
import {
  assertColumnOwnedBy,
  BROWSER_PROJECTION_WRITER,
  registerProjectionWriter,
} from "../projection";

const SECOND_WRITER = "ai-seam";

describe("a second projection writer is rejected", () => {
  test("registering a second, different writer throws (exactly one owner)", () => {
    registerProjectionWriter(BROWSER_PROJECTION_WRITER);
    expect(() => registerProjectionWriter(SECOND_WRITER)).toThrow();
  });

  test("a second writer touching the embedding column throws (the AI seam never writes)", () => {
    registerProjectionWriter(BROWSER_PROJECTION_WRITER);
    expect(() => assertColumnOwnedBy("embedding", SECOND_WRITER)).toThrow();
  });

  test("a second writer touching any owned column throws (no shared ownership)", () => {
    registerProjectionWriter(BROWSER_PROJECTION_WRITER);
    expect(() => assertColumnOwnedBy("title", SECOND_WRITER)).toThrow();
    expect(() =>
      assertColumnOwnedBy("updated_cursor", SECOND_WRITER)
    ).toThrow();
  });
});
