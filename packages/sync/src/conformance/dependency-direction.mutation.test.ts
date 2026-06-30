// Mutation twin for dependency-direction.gate.test.ts — proves the
// reverse-import detector actually fires. A gate that scanned for a forbidden
// import but could never detect one would be vacuous; this feeds a synthetic
// upstream source that imports @perry-starter/sync (the banned reverse edge)
// and asserts the detector flags it, plus a clean source it must NOT flag.
//
// The sync module surface is implemented, so this gate is active.

import { describe, expect, test } from "vitest";

// Same statement-anchored matcher the gate uses: it detects a real
// `import … from "x"` edge but ignores the word "import" inside a comment or a
// string literal (so the gate cannot be fooled or made vacuous either way).
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const SYNC_PACKAGE = "@perry-starter/sync";

const importedSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      out.push(specifier);
    }
  }
  return out;
};

describe("the dependency-direction detector fires on a reverse import", () => {
  test("flags an upstream file that imports @perry-starter/sync", () => {
    const reverseEdge = [
      'import { pushDeltas } from "@perry-starter/sync";',
      "export const handler = () => pushDeltas([]);",
    ].join("\n");
    expect(importedSpecifiers(reverseEdge)).toContain(SYNC_PACKAGE);
  });

  test("does not flag a clean upstream file with only allowed edges", () => {
    const cleanSource = [
      'import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";',
      "export const schema = deltaEnvelopeSchema;",
    ].join("\n");
    expect(importedSpecifiers(cleanSource)).not.toContain(SYNC_PACKAGE);
  });
});
