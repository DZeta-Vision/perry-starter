// Acceptance suite — cross-cutting conformance gates.
//   - the canonical shapes are hand-authored runtime Zod, not generated types;
//   - the gates are anti-vacuous: every gate ships its mutation twin (meta-gate);
//   - naming conventions hold: snake_case keys, ISO timestamps, ULID ids.
//
// The domain-neutrality source scan and the typegen-import source guard are
// owned by their named, twin-paired gates under src/conformance — they are no
// longer duplicated here.
//
// The canonical shapes are imported dynamically; top-level imports are limited to
// vitest + node builtins. The FS pairing scan targets packages/db/src.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/db/test
const DB_SRC = resolve(HERE, "..", "src"); // packages/db/src
const REPO_ROOT = resolve(HERE, "..", "..", ".."); // repo root
const META_GATE = resolve(REPO_ROOT, "scripts", "meta-gate.mjs");

// ── Top-level regex literals (never built in a loop) ───────────────────────────
const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

const GATE_SUFFIX = ".gate.test.ts";
const MUTATION_SUFFIX = ".mutation.test.ts";

// ── Pure detectors ─────────────────────────────────────────────────────────────
const isRuntimeValidator = (candidate: unknown): boolean => {
  const shape = candidate as { parse?: unknown; safeParse?: unknown } | null;
  return (
    typeof shape?.parse === "function" && typeof shape?.safeParse === "function"
  );
};

// A gate with no sibling twin is an orphan (mirrors the meta-gate pairing rule).
const orphanGates = (gateFiles: string[], twinFiles: string[]): string[] => {
  const twins = new Set(twinFiles);
  return gateFiles.filter(
    (gate) => !twins.has(gate.slice(0, -GATE_SUFFIX.length) + MUTATION_SUFFIX)
  );
};

const readDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walk = (dir: string, match: (name: string) => boolean): string[] => {
  const out: string[] = [];
  for (const entry of readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...walk(full, match));
      }
    } else if (entry.isFile() && match(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

// Dynamic — every specifier resolves against the implemented package.
const importAllShapes = async () => {
  const [deltaMod, projectionMod, auditMod, collabMod, documentsMod] =
    await Promise.all([
      import("@perry-starter/db/shapes/delta-envelope"),
      import("@perry-starter/db/shapes/document-projection"),
      import("@perry-starter/db/shapes/audit-entry"),
      import("@perry-starter/db/collaboration-mode"),
      import("@perry-starter/db/documents"),
    ]);
  return {
    deltaEnvelopeSchema: deltaMod.deltaEnvelopeSchema,
    documentProjectionSchema: projectionMod.documentProjectionSchema,
    auditEntrySchema: auditMod.auditEntrySchema,
    collaborationModeSchema: collabMod.collaborationModeSchema,
    documentsEntitySchema: documentsMod.documentsEntitySchema,
  };
};

// ──────────────────────────────────────────────────────────────────────────────
describe("documents reference entity is domain-neutral", () => {
  // The source-level neutrality scan lives in domain-neutrality.gate.test.ts;
  // here we assert the schema-level guarantee only.
  test("the generic documents entity parses with domain-neutral snake_case fields", async () => {
    const mod = await import("@perry-starter/db/documents");
    const documentsEntitySchema = mod.documentsEntitySchema;
    expect(
      documentsEntitySchema.safeParse({
        doc_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        scope_user_id: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
        title: "Untitled",
        body_preview: "A generic document body preview.",
      }).success
    ).toBe(true);
  });

  test("the schema rejects a fixture carrying a domain-coupled field", async () => {
    const mod = await import("@perry-starter/db/documents");
    const documentsEntitySchema = mod.documentsEntitySchema;
    expect(
      documentsEntitySchema.safeParse({
        doc_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        scope_user_id: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
        title: "Untitled",
        body_preview: "preview",
        maths_club_id: "coupled",
      }).success
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("canonical shapes are hand-authored runtime Zod", () => {
  test("every canonical shape is a runtime Zod validator exposing .parse / .safeParse", async () => {
    const shapes = await importAllShapes();
    for (const shape of Object.values(shapes)) {
      // A bare TypeScript interface has no runtime .parse.
      expect(isRuntimeValidator(shape)).toBe(true);
    }
  });

  test("a TS-interface stand-in (bare object literal, no .parse) fails the runtime-validator assertion", () => {
    const interfaceStandIn = { doc_id: "string", scope_user_id: "string" };
    expect(isRuntimeValidator(interfaceStandIn)).toBe(false);
    expect(isRuntimeValidator({})).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("anti-vacuous gates; every gate ships its mutation twin", () => {
  test("node scripts/meta-gate.mjs exits 0 — every packages/db gate ships its twin", () => {
    // The real blocking meta-gate passes once every *.gate.test.ts has a twin.
    expect(() =>
      execFileSync("node", [META_GATE], { stdio: "pipe" })
    ).not.toThrow();
  });

  test("every authored packages/db gate has a sibling mutation twin (FS pairing)", () => {
    const gates = walk(DB_SRC, (name) => name.endsWith(GATE_SUFFIX));
    const twins = walk(DB_SRC, (name) => name.endsWith(MUTATION_SUFFIX));
    expect(orphanGates(gates, twins)).toEqual([]);
  });

  test("the pairing detector flags a gate missing its mutation twin (self-proving red direction)", () => {
    // A gate without its twin is reported as an orphan.
    expect(
      orphanGates(
        ["x/a.gate.test.ts", "x/b.gate.test.ts"],
        ["x/a.mutation.test.ts"]
      )
    ).toEqual(["x/b.gate.test.ts"]);
    // Fully-paired set → zero orphans (proves it is not always-true).
    expect(orphanGates(["x/a.gate.test.ts"], ["x/a.mutation.test.ts"])).toEqual(
      []
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("naming conventions: snake_case keys, ISO timestamps, ULID ids", () => {
  test("every canonical shape key is snake_case", async () => {
    const shapes = await importAllShapes();
    const keysetOf = (schema: unknown): string[] => {
      const objectSchema = schema as { shape?: Record<string, unknown> };
      return objectSchema.shape ? Object.keys(objectSchema.shape) : [];
    };
    const keysets = [
      keysetOf(shapes.deltaEnvelopeSchema),
      keysetOf(shapes.documentProjectionSchema),
      keysetOf(shapes.auditEntrySchema),
      keysetOf(shapes.documentsEntitySchema),
    ];
    for (const keyset of keysets) {
      // Each shape must expose at least one key (guards a vacuous empty keyset).
      expect(keyset.length).toBeGreaterThan(0);
      for (const key of keyset) {
        expect(SNAKE_CASE_KEY.test(key)).toBe(true);
      }
    }
  });

  test("the field-name asserter flags a camelCase key (docId)", () => {
    // camelCase is rejected, snake_case is accepted.
    expect(SNAKE_CASE_KEY.test("docId")).toBe(false);
    expect(SNAKE_CASE_KEY.test("updatedCursor")).toBe(false);
    expect(SNAKE_CASE_KEY.test("doc_id")).toBe(true);
    expect(SNAKE_CASE_KEY.test("updated_cursor")).toBe(true);
  });

  test("a non-ISO timestamp and a non-ULID id are rejected by their validators", async () => {
    const mod = await import("@perry-starter/db/shapes/audit-entry");
    const auditEntrySchema = mod.auditEntrySchema;
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
    // Canonical ISO ts + ULID id parse.
    expect(auditEntrySchema.safeParse(base).success).toBe(true);
    // Non-ISO timestamp rejected.
    expect(
      auditEntrySchema.safeParse({ ...base, timestamp: "yesterday" }).success
    ).toBe(false);
    // Non-ULID id rejected.
    expect(
      auditEntrySchema.safeParse({ ...base, id: "not-a-ulid" }).success
    ).toBe(false);
  });
});
