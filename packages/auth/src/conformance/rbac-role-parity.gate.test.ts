// Cross-layer RBAC role-parity conformance gate.
//
// The two enforcement legs MUST agree. The FIRST leg is the tRPC middleware
// projection; the SECOND is the hand-authored SurrealDB row `PERMISSIONS` in
// `packages/db/database/schema/documents.surql`. A capability can never be
// granted by one leg and denied by the other.
//
// Two checks ship GREEN here:
//   1. the two TS projections of the one matrix are byte-equal (internal), and
//   2. THE REAL CROSS-LEG CHECK — the row escalation predicate generated FROM the
//      matrix via `escalationPredicateFor()` byte-matches the predicate actually
//      authored in the `.surql`. If a future edit drifts the matrix from the
//      `.surql` (or vice versa), check (2) reddens — it reaches the real second
//      leg, not just a second projection of the same object.
//
// The mutation twin (rbac-role-parity.mutation.test.ts) drives the SAME checks
// against drifted inputs and asserts they go RED — proving the gate is
// anti-vacuous (it can fail).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  escalationPredicateFor,
  middlewareCapabilityMap,
  permissionsCapabilityMap,
  permissionsMapForClaim,
  resolveGlobalRoles,
  roleParity,
} from "@perry-starter/auth/rbac";
import { expect, test } from "vitest";

const TIERS = ["member", "admin", "superadmin"] as const;

// Parse the hand-authored audit_log `FOR select WHERE <predicate>` out of the
// merged schema — the REAL second leg the matrix must match.
const TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|DEFINE\s+FIELD\b|$)/gi;
const COMMENT_RE = /--[^\n]*/g;
const AUDIT_SELECT_RE = /FOR\s+select\s+WHERE\s+([\s\S]*?)\s*(?=\bFOR\b|;)/i;
const WS_RE = /\s+/g;

const normalize = (clause: string): string => clause.replace(WS_RE, " ").trim();

// Extract the normalized audit_log select predicate from a SurrealQL schema.
const auditSelectPredicate = (schema: string): string => {
  const code = schema.replace(COMMENT_RE, "");
  const audit = [...code.matchAll(TABLE_RE)].find((m) => m[1] === "audit_log");
  if (!audit) {
    return "";
  }
  const match = AUDIT_SELECT_RE.exec(audit[0]);
  return match ? normalize(match[1]) : "";
};

// The matrix-derived predicate: the tiers that hold `audit:read` in the ONE
// matrix, fed through the generator. Drift the matrix and this string changes.
const matrixAuditPredicate = (): string => {
  const map = permissionsCapabilityMap();
  const readers = TIERS.filter((tier) =>
    (map[tier].audit ?? []).includes("read")
  );
  return normalize(escalationPredicateFor(readers));
};

const readMergedSchema = (): string => {
  const dir = join(process.cwd(), "packages", "db", "database", "schema");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".surql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
};

test("the middleware and row-PERMISSIONS legs are parity-equal projections of the one matrix", () => {
  const result = roleParity(
    middlewareCapabilityMap(),
    permissionsCapabilityMap()
  );
  expect(result.parity).toBe(true);
  expect(result.drifts).toEqual([]);
});

test("the row escalation predicate generated from the matrix matches the hand-authored .surql leg", () => {
  // The REAL cross-leg check: the generator's output (from the matrix) must equal
  // the predicate authored in documents.surql. This reaches the actual second
  // leg — a matrix/.surql drift makes these diverge and reddens the gate.
  const expected = matrixAuditPredicate();
  expect(expected.length).toBeGreaterThan(0);
  expect(auditSelectPredicate(readMergedSchema())).toBe(expected);
});

test("the row scope generated for a global-admin claim matches the middleware admin scope", () => {
  const generated = permissionsMapForClaim({
    user: { role: "admin" },
  });
  expect(generated).toEqual(middlewareCapabilityMap().admin);
});

test("the app-authz tier is resolved from the GLOBAL user.role claim split on commas", () => {
  expect(
    [...resolveGlobalRoles({ user: { role: "admin,member" } })].sort()
  ).toEqual(["admin", "member"]);
  // The org-structural role is never read for the authz tier.
  expect(resolveGlobalRoles({ user: { role: "member" } })).not.toContain(
    "owner"
  );
});
