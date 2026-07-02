// Recovery-code table conformance gate.
//
// Break-glass recovery codes are secrets: the table must be SEALED (no
// record-access session reads or mutates a row directly), it must store ONLY a
// hash (never a plaintext code column), and it must carry the single-use spend
// marker (`used_at`) and the owning user reference. This gate reads the merged
// `.surql` schema and asserts every one of those properties against the real
// `recovery_code` table.
//
// It ships GREEN against the shipped schema; its mutation twin feeds the SAME
// checker (duplicated verbatim — test files must not import one another) known-bad
// definitions (an unsealed table, a plaintext-code column, a missing spend marker)
// and asserts each goes RED — proving the gate is anti-vacuous.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const RECOVERY_TABLE_STMT_RE =
  /DEFINE\s+TABLE\s+recovery_code\b[\s\S]*?(?=DEFINE\s+(?:TABLE|FIELD|INDEX|ACCESS|EVENT)\b|$)/i;
const SEALED_RE = /\bPERMISSIONS\s+NONE\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;
const HASHED_CODE_FIELD_RE =
  /DEFINE\s+FIELD\s+hashed_code\s+ON\s+(?:TABLE\s+)?recovery_code\b/i;
const USED_AT_FIELD_RE =
  /DEFINE\s+FIELD\s+used_at\s+ON\s+(?:TABLE\s+)?recovery_code\b/i;
const USER_REF_FIELD_RE =
  /DEFINE\s+FIELD\s+user_ref\s+ON\s+(?:TABLE\s+)?recovery_code\b/i;
// A plaintext-code column in ANY casing is forbidden — only the hash is stored.
const PLAINTEXT_CODE_FIELD_RE =
  /DEFINE\s+FIELD\s+(?:code|plain_code|plaintext|plaintext_code|raw_code)\s+ON\s+(?:TABLE\s+)?recovery_code\b/i;
const SURQL_COMMENT_RE = /--[^\n]*/g;

// The single checker the gate and its mutation twin share (duplicated verbatim in
// recovery-code.mutation.test.ts). Returns one string per violation.
export const recoveryCodeViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = RECOVERY_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE recovery_code statement found"];
  }

  // Sealed: PERMISSIONS NONE, never FULL, never a per-op grant.
  if (
    !SEALED_RE.test(tableStmt) ||
    PERMISSIONS_FULL_RE.test(tableStmt) ||
    GRANT_RE.test(tableStmt)
  ) {
    violations.push("recovery_code is not sealed (PERMISSIONS NONE)");
  }

  // Only the hash is stored — never a plaintext code column.
  if (PLAINTEXT_CODE_FIELD_RE.test(code)) {
    violations.push("recovery_code stores a plaintext code column");
  }
  if (!HASHED_CODE_FIELD_RE.test(code)) {
    violations.push("recovery_code has no hashed_code field");
  }
  // Single-use spend marker + owning user reference.
  if (!USED_AT_FIELD_RE.test(code)) {
    violations.push("recovery_code has no used_at (single-use) field");
  }
  if (!USER_REF_FIELD_RE.test(code)) {
    violations.push("recovery_code has no user_ref field");
  }

  return violations;
};

const readMergedSchema = (): string => {
  const dir = join(process.cwd(), "packages", "db", "database", "schema");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".surql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
};

test("the shipped recovery_code table is sealed, hash-only, and single-use", () => {
  expect(recoveryCodeViolations(readMergedSchema())).toEqual([]);
});
