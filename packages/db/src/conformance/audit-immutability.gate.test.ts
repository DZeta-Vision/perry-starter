// Audit-immutability conformance gate.
//
// The append-only audit trail is security-critical: no role (including superadmin)
// may rewrite or clear it, an arbitrary authenticated session may not append a
// forged event, its action is confined to the closed `<domain>.<verb>` vocabulary,
// and it carries a retention floor. This gate reads the merged `.surql` schema and
// asserts every one of those properties holds against the real `audit_log`.
//
// It ships GREEN against the shipped schema; its mutation twin feeds the SAME
// checker (duplicated verbatim — test files must not import one another) known-bad
// audit definitions (mutable UPDATE/DELETE, retention under the floor, an open
// FULL create, an unconstrained action, a member-readable select) and asserts each
// goes RED — proving the gate is anti-vacuous and cannot be silently green.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const RETENTION_FLOOR_DAYS = 90;

// Top-level regex literals (Biome: never build a regex inside a loop).
const SURQL_COMMENT_RE = /--[^\n]*/g;
// Capture each statement up to the next DEFINE keyword (never a bare `;`, which can
// appear inside a COMMENT string literal and truncate the match).
const AUDIT_TABLE_STMT_RE =
  /DEFINE\s+TABLE\s+audit_log\b[\s\S]*?(?=DEFINE\s+(?:TABLE|FIELD|INDEX|ACCESS|EVENT)\b|$)/i;
const AUDIT_ACTION_FIELD_RE =
  /DEFINE\s+FIELD\s+action\s+ON\s+(?:TABLE\s+)?audit_log\b[\s\S]*?(?=DEFINE\s+(?:TABLE|FIELD|INDEX|ACCESS|EVENT)\b|$)/i;
const UPDATE_DELETE_NONE_RE = /\bFOR\s+update\s*,?\s*delete\s+NONE\b/i;
const MUTABLE_GRANT_RE =
  /\bFOR\b[^;]*\b(?:update|delete)\b[^;]*\b(?:FULL|WHERE)\b/i;
const CREATE_FULL_RE = /\bFOR\s+create\s+FULL\b/i;
const CREATE_GATED_RE =
  /\bFOR\s+create\s+WHERE\b[\s\S]*?\$(?:auth|token)\.role\b/i;
const SELECT_FULL_RE = /\bFOR\s+select\s+FULL\b/i;
const SELECT_ADMIN_GATED_RE =
  /\bFOR\s+select\s+WHERE\b[\s\S]*?\$(?:auth|token)\.role\b[\s\S]*?\badmin\b/i;
const ASSERT_RE = /\bASSERT\b/i;
const RETENTION_RE = /retention_days\s*=\s*(\d+)/i;
// The closed action-domain vocabulary the ASSERT must confine `action` to.
const ACTION_DOMAIN_RES = [
  /'auth'/i,
  /'admin'/i,
  /'session'/i,
  /'lockout'/i,
  /'user'/i,
] as const;

// The single checker the gate and its mutation twin share (duplicated verbatim in
// audit-immutability.mutation.test.ts). Returns one string per violation; an empty
// array means the audit table honors every immutability/least-privilege property.
export const auditImmutabilityViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = AUDIT_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE audit_log statement found"];
  }

  // Immutability: UPDATE and DELETE denied for EVERY role incl. superadmin.
  if (!UPDATE_DELETE_NONE_RE.test(tableStmt)) {
    violations.push(
      "audit_log is not append-only (missing FOR update, delete NONE)"
    );
  }
  if (MUTABLE_GRANT_RE.test(tableStmt)) {
    violations.push("audit_log grants a mutable UPDATE/DELETE clause");
  }

  // Write gate: CREATE must be a gated system/admin write, never open FULL.
  if (CREATE_FULL_RE.test(tableStmt)) {
    violations.push(
      "audit_log create is open (FOR create FULL) — write path fails open"
    );
  }
  if (!CREATE_GATED_RE.test(tableStmt)) {
    violations.push(
      "audit_log create is not gated to a system/admin write flow"
    );
  }

  // Read gate: SELECT permitted only to the admin/superadmin tier.
  if (SELECT_FULL_RE.test(tableStmt)) {
    violations.push("audit_log select is open (FOR select FULL)");
  }
  if (!SELECT_ADMIN_GATED_RE.test(tableStmt)) {
    violations.push(
      "audit_log select is not gated to the admin/superadmin tier"
    );
  }

  // Action vocabulary: the field must ASSERT the closed `<domain>.<verb>` set.
  const actionStmt = AUDIT_ACTION_FIELD_RE.exec(code)?.[0];
  if (!actionStmt) {
    violations.push("no DEFINE FIELD action ON audit_log statement found");
  } else if (!ASSERT_RE.test(actionStmt)) {
    violations.push("audit_log action field carries no ASSERT constraint");
  } else if (!ACTION_DOMAIN_RES.every((re) => re.test(actionStmt))) {
    violations.push(
      "audit_log action ASSERT does not confine the closed domain vocabulary"
    );
  }

  // Retention floor.
  const retentionMatch = RETENTION_RE.exec(code);
  if (!retentionMatch) {
    violations.push("audit_log declares no retention_days contract");
  } else if (Number(retentionMatch[1]) < RETENTION_FLOOR_DAYS) {
    violations.push(
      `audit_log retention ${retentionMatch[1]}d is under the ${RETENTION_FLOOR_DAYS}-day floor`
    );
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

test("the shipped audit_log is append-only, admin-gated, action-constrained and retained", () => {
  expect(auditImmutabilityViolations(readMergedSchema())).toEqual([]);
});
