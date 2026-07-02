// Mutation twin for invitation-model.gate.test.ts.
//
// The gate ships GREEN against the real schema. This twin feeds the SAME checker
// (duplicated verbatim — test files must not import one another) known-bad
// invitation definitions and asserts each goes RED, proving the gate is anti-vacuous
// and cannot be silently green. A correct minimal definition stays green.

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
const PLAINTEXT_TOKEN_FIELD_RE =
  /DEFINE\s+FIELD\s+(?:token|plain_token|plaintext|plaintext_token|raw_token)\s+ON\s+(?:TABLE\s+)?invitation\b/i;
const SURQL_COMMENT_RE = /--[^\n]*/g;

// Duplicated verbatim from invitation-model.gate.test.ts.
const invitationModelViolations = (schema: string): string[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const violations: string[] = [];

  const tableStmt = INVITATION_TABLE_STMT_RE.exec(code)?.[0];
  if (!tableStmt) {
    return ["no DEFINE TABLE invitation statement found"];
  }

  if (
    !SEALED_RE.test(tableStmt) ||
    PERMISSIONS_FULL_RE.test(tableStmt) ||
    GRANT_RE.test(tableStmt)
  ) {
    violations.push("invitation table is not sealed (PERMISSIONS NONE)");
  }

  if (PLAINTEXT_TOKEN_FIELD_RE.test(code)) {
    violations.push("invitation stores a plaintext token column");
  }
  if (!TOKEN_HASH_FIELD_RE.test(code)) {
    violations.push("invitation has no token_hash field");
  }

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

// A correct, minimal invitation definition — the green baseline the twin proves the
// checker still passes.
const GOOD = `
DEFINE TABLE invitation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD email ON invitation TYPE string;
DEFINE FIELD role ON invitation TYPE string;
DEFINE FIELD token_hash ON invitation TYPE string;
DEFINE FIELD status ON invitation TYPE string DEFAULT 'pending';
DEFINE FIELD expires_at ON invitation TYPE datetime;
DEFINE FIELD accepted_at ON invitation TYPE option<datetime>;
`;

test("a correct minimal invitation definition passes the checker", () => {
  expect(invitationModelViolations(GOOD)).toEqual([]);
});

test("an unsealed invitation table reddens the checker", () => {
  const unsealed = GOOD.replace(
    "DEFINE TABLE invitation SCHEMAFULL PERMISSIONS NONE;",
    "DEFINE TABLE invitation SCHEMAFULL PERMISSIONS FOR select FULL;"
  );
  expect(invitationModelViolations(unsealed)).toContain(
    "invitation table is not sealed (PERMISSIONS NONE)"
  );
});

test("a plaintext token column reddens the checker", () => {
  const withPlaintext = `${GOOD}\nDEFINE FIELD token ON invitation TYPE string;`;
  expect(invitationModelViolations(withPlaintext)).toContain(
    "invitation stores a plaintext token column"
  );
});

test("a missing status field reddens the checker", () => {
  const noStatus = GOOD.replace(
    "DEFINE FIELD status ON invitation TYPE string DEFAULT 'pending';\n",
    ""
  );
  expect(invitationModelViolations(noStatus)).toContain(
    "invitation has no status (lifecycle) field"
  );
});

test("a missing expiry field reddens the checker", () => {
  const noExpiry = GOOD.replace(
    "DEFINE FIELD expires_at ON invitation TYPE datetime;\n",
    ""
  );
  expect(invitationModelViolations(noExpiry)).toContain(
    "invitation has no expires_at (TTL) field"
  );
});

test("a missing accepted_at (single-use) field reddens the checker", () => {
  const noAccepted = GOOD.replace(
    "DEFINE FIELD accepted_at ON invitation TYPE option<datetime>;\n",
    ""
  );
  expect(invitationModelViolations(noAccepted)).toContain(
    "invitation has no accepted_at (single-use) field"
  );
});
