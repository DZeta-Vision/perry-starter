// Mutation twin for the recovery-code conformance gate.
//
// The checker is duplicated VERBATIM from recovery-code.gate.test.ts (test files
// must not import one another). It is fed known-bad recovery_code definitions and
// each MUST redden, plus a good control that stays green — proving the gate is
// anti-vacuous and cannot be silently green.

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
const PLAINTEXT_CODE_FIELD_RE =
  /DEFINE\s+FIELD\s+(?:code|plain_code|plaintext|plaintext_code|raw_code)\s+ON\s+(?:TABLE\s+)?recovery_code\b/i;
const SURQL_COMMENT_RE = /--[^\n]*/g;

const recoveryCodeViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = RECOVERY_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE recovery_code statement found"];
  }

  if (
    !SEALED_RE.test(tableStmt) ||
    PERMISSIONS_FULL_RE.test(tableStmt) ||
    GRANT_RE.test(tableStmt)
  ) {
    violations.push("recovery_code is not sealed (PERMISSIONS NONE)");
  }
  if (PLAINTEXT_CODE_FIELD_RE.test(code)) {
    violations.push("recovery_code stores a plaintext code column");
  }
  if (!HASHED_CODE_FIELD_RE.test(code)) {
    violations.push("recovery_code has no hashed_code field");
  }
  if (!USED_AT_FIELD_RE.test(code)) {
    violations.push("recovery_code has no used_at (single-use) field");
  }
  if (!USER_REF_FIELD_RE.test(code)) {
    violations.push("recovery_code has no user_ref field");
  }

  return violations;
};

// The good baseline (mirrors the shipped shape) — the control that stays green.
const GOOD = `
DEFINE TABLE recovery_code SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD hashed_code ON recovery_code TYPE string;
DEFINE FIELD used_at ON recovery_code TYPE option<datetime>;
DEFINE FIELD user_ref ON recovery_code TYPE record<user>;
`;

test("the good baseline recovery_code definition is clean", () => {
  expect(recoveryCodeViolations(GOOD)).toEqual([]);
});

test("an unsealed recovery_code table (PERMISSIONS FULL) reddens the gate", () => {
  const bad = GOOD.replace("PERMISSIONS NONE", "PERMISSIONS FULL");
  expect(recoveryCodeViolations(bad).length).toBeGreaterThan(0);
});

test("a recovery_code table granting a per-op permission reddens the gate", () => {
  const bad = GOOD.replace(
    "PERMISSIONS NONE",
    "PERMISSIONS FOR select WHERE user_ref = $auth"
  );
  expect(recoveryCodeViolations(bad).length).toBeGreaterThan(0);
});

test("a plaintext code column reddens the gate", () => {
  const bad = GOOD.replace(
    "DEFINE FIELD hashed_code ON recovery_code TYPE string;",
    "DEFINE FIELD hashed_code ON recovery_code TYPE string;\nDEFINE FIELD code ON recovery_code TYPE string;"
  );
  expect(recoveryCodeViolations(bad)).toContain(
    "recovery_code stores a plaintext code column"
  );
});

test("dropping the single-use spend marker reddens the gate", () => {
  const bad = GOOD.replace(
    "DEFINE FIELD used_at ON recovery_code TYPE option<datetime>;",
    ""
  );
  expect(recoveryCodeViolations(bad)).toContain(
    "recovery_code has no used_at (single-use) field"
  );
});

test("dropping the hash column reddens the gate", () => {
  const bad = GOOD.replace(
    "DEFINE FIELD hashed_code ON recovery_code TYPE string;",
    ""
  );
  expect(recoveryCodeViolations(bad)).toContain(
    "recovery_code has no hashed_code field"
  );
});
