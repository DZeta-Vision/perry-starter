// Mutation twin for rbac-role-parity.gate.test.ts.
//
// It feeds the real parity checker AND the real cross-leg predicate comparison
// known-bad inputs and asserts they report drift, proving the gate is
// anti-vacuous: a drifted leg, a mis-split comma-string role, or a matrix/.surql
// divergence makes the gate go RED. If these passed against the real artifacts
// the gate would be vacuous.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  escalationPredicateFor,
  middlewareCapabilityMap,
  permissionsCapabilityMap,
  permissionsMapForClaim,
  roleParity,
} from "@perry-starter/auth/rbac";
import { expect, test } from "vitest";

test("dropping a capability from only one leg makes the checker report drift", () => {
  const middleware = middlewareCapabilityMap();
  const permissions = permissionsCapabilityMap();
  // Drift the row leg: admin loses document.delete on ONE leg only.
  const drifted = {
    ...permissions,
    admin: {
      ...permissions.admin,
      document: (permissions.admin.document ?? []).filter(
        (c) => c !== "delete"
      ),
    },
  };
  const result = roleParity(middleware, drifted);
  expect(result.parity).toBe(false);
  expect(result.drifts.length).toBeGreaterThan(0);
});

test("adding a capability to only one leg makes the checker report drift", () => {
  const middleware = middlewareCapabilityMap();
  const permissions = permissionsCapabilityMap();
  const drifted = {
    ...middleware,
    member: {
      ...middleware.member,
      document: [...(middleware.member.document ?? []), "delete"],
    },
  };
  expect(roleParity(drifted, permissions).parity).toBe(false);
});

test("a claim carrying only the org role resolves the wrong tier and diverges from the admin scope", () => {
  // A correct generator keys on the GLOBAL user.role. A mis-split that fell back
  // to the org-structural role (here simulated by an absent user.role) resolves
  // the default member tier, NOT admin — so the generated scope diverges from the
  // middleware admin scope. The divergence is exactly what the gate must catch.
  const misSplit = permissionsMapForClaim({ user: {} });
  expect(misSplit).not.toEqual(middlewareCapabilityMap().admin);
});

// --- The cross-leg drift detector twin (matrix-derived predicate vs the .surql)

// Duplicated verbatim from the gate (test files must not import one another).
const TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|DEFINE\s+FIELD\b|$)/gi;
const COMMENT_RE = /--[^\n]*/g;
const AUDIT_SELECT_RE = /FOR\s+select\s+WHERE\s+([\s\S]*?)\s*(?=\bFOR\b|;)/i;
const WS_RE = /\s+/g;

const normalize = (clause: string): string => clause.replace(WS_RE, " ").trim();

const auditSelectPredicate = (schema: string): string => {
  const code = schema.replace(COMMENT_RE, "");
  const audit = [...code.matchAll(TABLE_RE)].find((m) => m[1] === "audit_log");
  if (!audit) {
    return "";
  }
  const match = AUDIT_SELECT_RE.exec(audit[0]);
  return match ? normalize(match[1]) : "";
};

const readMergedSchema = (): string => {
  const dir = join(process.cwd(), "packages", "db", "database", "schema");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".surql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
};

test("a matrix that widened the audit readers no longer matches the .surql predicate (drift caught)", () => {
  // Simulate the matrix granting `audit:read` to `member` too (a TS-leg edit
  // without a matching .surql edit). The generator now emits a member arm, which
  // the hand-authored .surql (admin/superadmin only) does NOT carry — so the
  // cross-leg comparison the gate runs would go RED.
  const driftedReaders = ["member", "admin", "superadmin"] as const;
  const driftedPredicate = normalize(escalationPredicateFor(driftedReaders));
  expect(auditSelectPredicate(readMergedSchema())).not.toBe(driftedPredicate);
});

test("a .surql whose audit clause dropped superadmin no longer matches the matrix predicate (drift caught)", () => {
  // Simulate the reverse: the .surql leg was edited to drop the superadmin arm
  // while the matrix still grants superadmin `audit:read`. The matrix-derived
  // predicate (admin OR superadmin) must NOT equal the truncated .surql clause.
  const driftedSchema = `
DEFINE TABLE audit_log SCHEMAFULL
  PERMISSIONS
    FOR create FULL
    FOR select WHERE string::split($auth.role, ',') CONTAINS 'admin'
    FOR update, delete NONE;`;
  const matrixPredicate = normalize(
    escalationPredicateFor(["admin", "superadmin"])
  );
  expect(auditSelectPredicate(driftedSchema)).not.toBe(matrixPredicate);
});
