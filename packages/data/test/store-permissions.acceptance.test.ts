// Acceptance tests for the row-level PERMISSIONS shape of the merged schema.
//
// Verify that every user-data table declares explicit row-level PERMISSIONS
// scoped to the authenticated record (none defaulting open), and that the
// delta-log table is fully denied to record-access sessions. The merged
// `.surql` schema is read via `node:fs` and parsed statically; no live sidecar
// is needed.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SCHEMA_DIR = join(process.cwd(), "packages", "db", "database", "schema");

// Top-level regex literals (Biome: never build regex inside loops).
const DEFINE_TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|$)/gi;
const PERMISSIONS_RE = /\bPERMISSIONS\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const PERMISSIONS_NONE_RE = /\bPERMISSIONS\s+NONE\b/i;
const AUTH_REF_RE = /\$auth\b/i;
const DELTA_GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;

interface TableBlock {
  readonly body: string;
  readonly name: string;
}

const readMergedSchema = (): string => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".surql"));
  return files.map((f) => readFileSync(join(SCHEMA_DIR, f), "utf8")).join("\n");
};

const parseTableBlocks = (schema: string): TableBlock[] => {
  const blocks: TableBlock[] = [];
  for (const match of schema.matchAll(DEFINE_TABLE_RE)) {
    blocks.push({ name: match[1], body: match[0] });
  }
  return blocks;
};

test("every DEFINE TABLE on user data carries explicit $auth-scoped row-level PERMISSIONS — none default open", () => {
  const schema = readMergedSchema();
  const tables = parseTableBlocks(schema);

  // There must be at least the `documents` user-data table to assert against.
  expect(tables.length).toBeGreaterThan(0);

  for (const table of tables) {
    // `document_delta` is intentionally PERMISSIONS NONE (covered separately);
    // every OTHER user-data table must carry explicit $auth-scoped PERMISSIONS.
    if (table.name === "document_delta") {
      continue;
    }
    // A DEFINE TABLE with no PERMISSIONS clause (table defaults open) fails.
    expect(PERMISSIONS_RE.test(table.body)).toBe(true);
    // A `PERMISSIONS FULL` (open to every record user) fails.
    expect(PERMISSIONS_FULL_RE.test(table.body)).toBe(false);
    // The clause must scope by the authenticated record (`$auth`), not a
    // blanket grant.
    expect(AUTH_REF_RE.test(table.body)).toBe(true);
  }
});

test("the document_delta table is PERMISSIONS NONE-shaped — no select/create/update/delete granted to record users", () => {
  const schema = readMergedSchema();
  const tables = parseTableBlocks(schema);
  const delta = tables.find((t) => t.name === "document_delta");

  // The cross-scope isolation perimeter is enforced server-side later; here
  // `document_delta` exists and denies all record-user access.
  expect(delta).toBeDefined();
  const body = (delta as TableBlock).body;

  // A `document_delta` that grants `FOR select WHERE …` (or any FOR clause) to
  // record users would fail this.
  expect(PERMISSIONS_NONE_RE.test(body)).toBe(true);
  expect(DELTA_GRANT_RE.test(body)).toBe(false);
});
