// Row-level PERMISSIONS shape conformance gate.
//
// Every owner-data table must declare explicit $auth-scoped PERMISSIONS (never
// implicit-open, never PERMISSIONS FULL); the credential + delta-log tables stay
// PERMISSIONS NONE; the audit table is append-only (FOR update, delete NONE for
// EVERY role incl. superadmin); and admin/superadmin escalation is keyed on the
// GLOBAL role claim ($auth.role / $token.role), never an org-structural role.
//
// This gate ships GREEN against the real merged schema; its mutation twin feeds
// the SAME checker (duplicated verbatim) known-bad schemas (open table,
// PERMISSIONS FULL, an audit grant of update/delete, an org-role-keyed admin
// clause) and asserts each goes RED.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SEALED_TABLES = new Set([
  "user",
  "document_delta",
  "document_projection",
  "recovery_code",
  "invitation",
]);
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

// The single checker the gate and its mutation twin share (duplicated verbatim in
// rbac-permissions.mutation.test.ts). Returns one string per violation; an empty
// array means the schema honors the row-PERMISSIONS shape.
export const surqlPermissionViolations = (schema: string): string[] => {
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

const readMergedSchema = (): string => {
  const dir = join(process.cwd(), "packages", "db", "database", "schema");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".surql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
};

test("the merged .surql schema has zero row-PERMISSIONS shape violations", () => {
  expect(surqlPermissionViolations(readMergedSchema())).toEqual([]);
});
