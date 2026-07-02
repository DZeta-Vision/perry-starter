// Invitation-model conformance gate.
//
// The pending-invitation table holds a single-use secret (the token) and the
// role-to-stamp-on-acceptance, so it must be SEALED (no record-access session reads
// or mutates a row directly), it must store ONLY a token DIGEST (never a plaintext
// token column), and it must carry the lifecycle fields the single-use / TTL /
// no-half-formed-account properties depend on (status, expires_at, accepted_at,
// role). This gate reads the merged `.surql` schema and asserts every one of those
// properties against the real `invitation` table.
//
// It ships GREEN against the shipped schema; its mutation twin feeds the SAME
// checker (duplicated verbatim — test files must not import one another) known-bad
// definitions (an unsealed table, a plaintext-token column, a missing status /
// expiry field) and asserts each goes RED — proving the gate is anti-vacuous.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const INVITATION_TABLE_STMT_RE =
  /DEFINE\s+TABLE\s+invitation\b[\s\S]*?(?=DEFINE\s+(?:TABLE|FIELD|INDEX|ACCESS|EVENT)\b|$)/i;
const SEALED_RE = /\bPERMISSIONS\s+NONE\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;
const TOKEN_HASH_FIELD_RE =
  /DEFINE\s+FIELD\s+token_hash\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const STATUS_FIELD_RE =
  /DEFINE\s+FIELD\s+status\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const EXPIRES_FIELD_RE =
  /DEFINE\s+FIELD\s+expires_at\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const ACCEPTED_FIELD_RE =
  /DEFINE\s+FIELD\s+accepted_at\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const ROLE_FIELD_RE = /DEFINE\s+FIELD\s+role\s+ON\s+(?:TABLE\s+)?invitation\b/i;
// A plaintext-token column in ANY common casing is forbidden — only the digest is
// stored.
const PLAINTEXT_TOKEN_FIELD_RE =
  /DEFINE\s+FIELD\s+(?:token|plain_token|plaintext|plaintext_token|raw_token)\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const SURQL_COMMENT_RE = /--[^\n]*/g;

// The single checker the gate and its mutation twin share (duplicated verbatim in
// invitation-model.mutation.test.ts). Returns one string per violation.
export const invitationModelViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = INVITATION_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE invitation statement found"];
  }

  // Sealed: PERMISSIONS NONE, never FULL, never a per-op grant.
  if (
    !SEALED_RE.test(tableStmt) ||
    PERMISSIONS_FULL_RE.test(tableStmt) ||
    GRANT_RE.test(tableStmt)
  ) {
    violations.push("invitation table is not sealed (PERMISSIONS NONE)");
  }

  // Only the token digest is stored — never a plaintext token column.
  if (PLAINTEXT_TOKEN_FIELD_RE.test(code)) {
    violations.push("invitation stores a plaintext token column");
  }
  if (!TOKEN_HASH_FIELD_RE.test(code)) {
    violations.push("invitation has no token_hash field");
  }

  // Lifecycle fields: status (single-use / revoked / expired), expires_at (TTL),
  // accepted_at (single-use spend marker), role (stamped on acceptance).
  if (!STATUS_FIELD_RE.test(code)) {
    violations.push("invitation has no status (lifecycle) field");
  }
  if (!EXPIRES_FIELD_RE.test(code)) {
    violations.push("invitation has no expires_at (TTL) field");
  }
  if (!ACCEPTED_FIELD_RE.test(code)) {
    violations.push("invitation has no accepted_at (single-use) field");
  }
  if (!ROLE_FIELD_RE.test(code)) {
    violations.push("invitation has no role field");
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

test("the shipped invitation table is sealed, token-digest-only, and carries the lifecycle fields", () => {
  expect(invitationModelViolations(readMergedSchema())).toEqual([]);
});
