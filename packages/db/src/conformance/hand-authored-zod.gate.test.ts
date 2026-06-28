/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collaborationModeSchema } from "../collaboration-mode";
import { documentsEntitySchema } from "../documents";
import { auditEntrySchema } from "../shapes/audit-entry";
import { deltaEnvelopeSchema } from "../shapes/delta-envelope";
import { documentProjectionSchema } from "../shapes/document-projection";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/db/src/conformance
const DB_SHAPES = resolve(HERE, "..", "shapes"); // packages/db/src/shapes

const TS_FILE = /\.ts$/;
// A source line wiring a generated typegen artifact as a source of truth.
const TYPEGEN_IMPORT = /from\s+["'][^"']*(?:surrealkit|typegen)[^"']*["']/i;

interface RuntimeSchema {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
}

const isRuntimeValidator = (candidate: unknown): boolean => {
  const shape = candidate as { parse?: unknown; safeParse?: unknown } | null;
  return (
    typeof shape?.parse === "function" && typeof shape?.safeParse === "function"
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

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ULID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const ISO_TIMESTAMP = "2026-06-28T12:00:00.000Z";
const PAYLOAD_B64 = "aGVsbG8=";

// Each canonical shape paired with a valid fixture that must survive `.parse`
// unchanged — no canonical shape coerces or transforms its input.
const canonicalCases = [
  {
    name: "delta envelope",
    schema: deltaEnvelopeSchema as RuntimeSchema,
    valid: {
      id: ULID_A,
      scope_user_id: ULID_B,
      doc_id: ULID_C,
      doc_schema_version: 1,
      cursor: 42,
      payload: PAYLOAD_B64,
    },
  },
  {
    name: "document projection",
    schema: documentProjectionSchema as RuntimeSchema,
    valid: {
      doc_id: ULID_C,
      scope_user_id: ULID_B,
      title: "Untitled",
      body_preview: "A generic document body preview.",
      embedding: null,
      embedding_model: "local-minilm-v2",
      updated_cursor: 7,
    },
  },
  {
    name: "audit entry",
    schema: auditEntrySchema as RuntimeSchema,
    valid: {
      id: ULID_A,
      action: "auth.sign_in",
      actor: ULID_C,
      actor_email: "person@example.com",
      actor_role: "member",
      target_type: "session",
      target_id: ULID_B,
      metadata: {},
      ip: "127.0.0.1",
      user_agent: "Mozilla/5.0",
      timestamp: ISO_TIMESTAMP,
    },
  },
  {
    name: "collaboration mode",
    schema: collaborationModeSchema as RuntimeSchema,
    valid: "private",
  },
  {
    name: "documents entity",
    schema: documentsEntitySchema as RuntimeSchema,
    valid: {
      doc_id: ULID_A,
      scope_user_id: ULID_B,
      title: "Untitled",
      body_preview: "A generic document body preview.",
    },
  },
];

describe("canonical shapes are hand-authored runtime Zod", () => {
  test("every canonical shape exposes runtime parse and safeParse", () => {
    for (const { schema } of canonicalCases) {
      expect(isRuntimeValidator(schema)).toBe(true);
    }
  });

  test("a valid fixture round-trips unchanged through parse for every canonical shape", () => {
    for (const { schema, valid } of canonicalCases) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.parse(valid)).toEqual(valid);
    }
  });

  test("no module under src/shapes wires a generated surrealkit/typegen import", () => {
    for (const file of walk(DB_SHAPES, (name) => TS_FILE.test(name))) {
      expect(TYPEGEN_IMPORT.test(readFileSync(file, "utf8"))).toBe(false);
    }
  });
});
