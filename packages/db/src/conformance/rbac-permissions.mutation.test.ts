// Mutation twin for rbac-permissions.gate.test.ts.
//
// The checker is duplicated verbatim from the gate (test files must not import one
// another) and fed known-bad schemas: an implicit-open owner-data table, a
// PERMISSIONS FULL table, an audit table that grants update/delete, and an admin
// clause keyed on the org member.role. Each MUST produce at least one violation —
// proving the gate is anti-vacuous (it can go RED).

import { expect, test } from "vitest";

const SEALED_TABLES = new Set(["user", "document_delta"]);
const AUDIT_TABLE = "audit_log";

const TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|DEFINE\s+FIELD\b|$)/gi;
const COMMENT_RE = /--[^\n]*/g;
const PERMISSIONS_RE = /\bPERMISSIONS\b/i;
const FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const NONE_RE = /\bPERMISSIONS\s+NONE\b/i;
const AUTH_RE = /\$auth\b/i;
const GLOBAL_CLAIM_RE = /\$(?:auth|token)\.role\b/i;
const ORG_MEMBER_ROLE_RE = /\bmember\.role\b/i;
const FOR_CREATE_RE = /\bFOR\s+[^;]*\bcreate\b/i;
const FOR_UPDATE_RE = /\bFOR\s+[^;]*\bupdate\b/i;
const FOR_DELETE_RE = /\bFOR\s+[^;]*\bdelete\b/i;
const UPDATE_DELETE_NONE_RE = /\bFOR\s+update\s*,?\s*delete\s+NONE\b/i;
const ANY_GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;

const surqlPermissionViolations = (schema: string): string[] => {
  const code = schema.replace(COMMENT_RE, "");
  const violations: string[] = [];
  let sawGlobalEscalation = false;
  const blocks = [...code.matchAll(TABLE_RE)].map((m) => ({
    name: m[1] ?? "",
    body: m[0],
  }));
  if (blocks.length === 0) {
    violations.push("no DEFINE TABLE blocks found");
  }
  for (const { name, body } of blocks) {
    if (ORG_MEMBER_ROLE_RE.test(body)) {
      violations.push(`${name}: keys the authz tier on the org member.role`);
    }
    if (GLOBAL_CLAIM_RE.test(body)) {
      sawGlobalEscalation = true;
    }
    if (SEALED_TABLES.has(name)) {
      if (!NONE_RE.test(body) || ANY_GRANT_RE.test(body)) {
        violations.push(`${name}: sealed table is not PERMISSIONS NONE`);
      }
      continue;
    }
    if (name === AUDIT_TABLE) {
      const appendOnly = UPDATE_DELETE_NONE_RE.test(body);
      if (!FOR_CREATE_RE.test(body)) {
        violations.push(`${name}: audit table lacks a create grant`);
      }
      if (!appendOnly) {
        violations.push(`${name}: audit table lacks FOR update, delete NONE`);
      }
      if (
        (FOR_UPDATE_RE.test(body) || FOR_DELETE_RE.test(body)) &&
        !appendOnly
      ) {
        violations.push(`${name}: audit table is not append-only`);
      }
      continue;
    }
    if (
      !PERMISSIONS_RE.test(body) ||
      FULL_RE.test(body) ||
      !AUTH_RE.test(body)
    ) {
      violations.push(`${name}: owner-data table not explicitly $auth-scoped`);
    }
  }
  if (!sawGlobalEscalation) {
    violations.push("no table escalates via the GLOBAL role claim");
  }
  return violations;
};

// A baseline that the checker accepts, so each mutation isolates ONE defect.
const GOOD_AUDIT = `
DEFINE TABLE audit_log SCHEMAFULL
  PERMISSIONS
    FOR create FULL
    FOR select WHERE $auth.role CONTAINS 'admin'
    FOR update, delete NONE;`;

test("an implicit-open owner-data table is flagged", () => {
  const bad = `DEFINE TABLE documents SCHEMAFULL;${GOOD_AUDIT}`;
  expect(surqlPermissionViolations(bad).length).toBeGreaterThan(0);
});

test("a PERMISSIONS FULL owner-data table is flagged", () => {
  const bad = `DEFINE TABLE documents SCHEMAFULL PERMISSIONS FULL;${GOOD_AUDIT}`;
  expect(surqlPermissionViolations(bad).length).toBeGreaterThan(0);
});

test("an audit table that grants update or delete is flagged", () => {
  const bad = `
DEFINE TABLE documents SCHEMAFULL PERMISSIONS FOR select WHERE owner = $auth;
DEFINE TABLE audit_log SCHEMAFULL
  PERMISSIONS
    FOR create FULL
    FOR select WHERE $auth.role CONTAINS 'admin'
    FOR update WHERE $auth.role CONTAINS 'superadmin';`;
  expect(surqlPermissionViolations(bad).length).toBeGreaterThan(0);
});

test("an admin clause keyed on the org member.role is flagged", () => {
  const bad = `DEFINE TABLE documents SCHEMAFULL PERMISSIONS FOR select WHERE owner = $auth OR member.role CONTAINS 'admin';${GOOD_AUDIT}`;
  expect(surqlPermissionViolations(bad).length).toBeGreaterThan(0);
});
