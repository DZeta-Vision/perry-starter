// Mutation twin for audit-immutability.gate.test.ts.
//
// The checker is duplicated verbatim from the gate (test files must not import one
// another) and fed a GOOD baseline it accepts plus five known-bad audit
// definitions, each isolating ONE defect: a mutable UPDATE/DELETE grant, a
// retention under the 90-day floor, an open FULL create (the audit-write fail-open),
// an unconstrained action field, and a member-readable (FULL) select. Each MUST
// produce at least one violation — proving the gate can go RED and is not vacuous.

import { expect, test } from "vitest";

const RETENTION_FLOOR_DAYS = 90;

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
const ACTION_DOMAIN_RES = [
  /'auth'/i,
  /'admin'/i,
  /'session'/i,
  /'lockout'/i,
  /'user'/i,
] as const;

const auditImmutabilityViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = AUDIT_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE audit_log statement found"];
  }

  if (!UPDATE_DELETE_NONE_RE.test(tableStmt)) {
    violations.push(
      "audit_log is not append-only (missing FOR update, delete NONE)"
    );
  }
  if (MUTABLE_GRANT_RE.test(tableStmt)) {
    violations.push("audit_log grants a mutable UPDATE/DELETE clause");
  }

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

  if (SELECT_FULL_RE.test(tableStmt)) {
    violations.push("audit_log select is open (FOR select FULL)");
  }
  if (!SELECT_ADMIN_GATED_RE.test(tableStmt)) {
    violations.push(
      "audit_log select is not gated to the admin/superadmin tier"
    );
  }

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

// A baseline the checker accepts, so each mutation below isolates ONE defect.
const GOOD = `
DEFINE TABLE audit_log SCHEMAFULL
  COMMENT 'append-only system-written audit trail. retention_days=90'
  PERMISSIONS
    FOR create WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'
    FOR select WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'
    FOR update, delete NONE;
DEFINE FIELD action ON audit_log TYPE string
  ASSERT array::len(string::split($value, '.')) >= 2 AND string::split($value, '.')[0] INSIDE ['auth', 'admin', 'session', 'lockout', 'user'];`;

test("the good baseline is accepted (isolating each mutation to one defect)", () => {
  expect(auditImmutabilityViolations(GOOD)).toEqual([]);
});

test("a superadmin-mutable UPDATE/DELETE audit table is flagged", () => {
  const bad = GOOD.replace(
    "FOR update, delete NONE",
    "FOR update, delete WHERE string::split($auth.role, ',') CONTAINS 'superadmin'"
  );
  expect(auditImmutabilityViolations(bad).length).toBeGreaterThan(0);
});

test("a retention under the 90-day floor is flagged", () => {
  const bad = GOOD.replace("retention_days=90", "retention_days=30");
  expect(auditImmutabilityViolations(bad).length).toBeGreaterThan(0);
});

test("an open FULL create (audit-write fail-open) is flagged", () => {
  const bad = GOOD.replace(
    "FOR create WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'",
    "FOR create FULL"
  );
  expect(auditImmutabilityViolations(bad).length).toBeGreaterThan(0);
});

const ACTION_FIELD_STMT_RE = /DEFINE FIELD action ON audit_log[\s\S]*?;/;

test("an unconstrained action field (no vocabulary ASSERT) is flagged", () => {
  const bad = GOOD.replace(
    ACTION_FIELD_STMT_RE,
    "DEFINE FIELD action ON audit_log TYPE string;"
  );
  expect(auditImmutabilityViolations(bad).length).toBeGreaterThan(0);
});

test("a member-readable (FULL) select is flagged", () => {
  const bad = GOOD.replace(
    "FOR select WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'",
    "FOR select FULL"
  );
  expect(auditImmutabilityViolations(bad).length).toBeGreaterThan(0);
});
