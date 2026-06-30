// Red-phase ATDD acceptance scaffold for the row-level PERMISSIONS matrix shape
// in the merged .surql schema.
//
// RED PHASE: every test is `test.skip` (aliased `acceptance`). The
// admin/superadmin escalation clauses and the append-only `audit_log` table DO
// NOT EXIST yet in `packages/db/database/schema/*.surql` (today only the
// self-scoped `documents` + sealed `user`/`document_delta` are present). At
// green phase the dev un-skips these and promotes them into the paired
// `*.gate.test.ts` + `*.mutation.test.ts` twin.
//
// Behavior asserted: every owner-data table declares explicit $auth-scoped
// PERMISSIONS (none default open, none FULL); admin/superadmin escalation keys
// on the GLOBAL role claim ($auth.role / $token.role), never the org
// member.role; the audit table is append-only (no update/delete for ANY role
// including superadmin); the credential + delta-log tables stay PERMISSIONS
// NONE. The schema is read via node:fs — no DB connection in this file.

import { describe, expect, test } from "vitest";

// GREEN PHASE: aliased to `test` so the intent reads at each call site.
const acceptance = test;

// Tables intentionally sealed to record-access sessions (PERMISSIONS NONE).
const SEALED_TABLES = new Set(["user", "document_delta"]);
// The append-only audit table (added at green phase).
const AUDIT_TABLE = "audit_log";

// Top-level regex literals (Biome: never build regex inside loops).
const DEFINE_TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|DEFINE\s+FIELD\b|$)/gi;
const SURQL_COMMENT_RE = /--[^\n]*/g;
const PERMISSIONS_RE = /\bPERMISSIONS\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const PERMISSIONS_NONE_RE = /\bPERMISSIONS\s+NONE\b/i;
const AUTH_REF_RE = /\$auth\b/i;
const GLOBAL_ROLE_CLAIM_RE = /\$(?:auth|token)\.role\b/i;
const ORG_MEMBER_ROLE_RE = /\bmember\.role\b/i;
const FOR_UPDATE_RE = /\bFOR\s+[^;]*\bupdate\b/i;
const FOR_DELETE_RE = /\bFOR\s+[^;]*\bdelete\b/i;
const FOR_CREATE_RE = /\bFOR\s+[^;]*\bcreate\b/i;
const FOR_UPDATE_DELETE_NONE_RE = /\bFOR\s+update\s*,?\s*delete\s+NONE\b/i;
const ANY_FOR_GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;

interface TableBlock {
  readonly body: string;
  readonly name: string;
}

const readMergedSchema = async (): Promise<string> => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "packages", "db", "database", "schema");
  const files = readdirSync(dir).filter((f) => f.endsWith(".surql"));
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};

const parseTableBlocks = (schema: string): TableBlock[] => {
  const code = schema.replace(SURQL_COMMENT_RE, "");
  const blocks: TableBlock[] = [];
  for (const match of code.matchAll(DEFINE_TABLE_RE)) {
    blocks.push({ name: match[1], body: match[0] });
  }
  return blocks;
};

describe("every owner-data table declares explicit $auth-scoped PERMISSIONS — none default open", () => {
  acceptance(
    "each non-sealed DEFINE TABLE carries an explicit PERMISSIONS clause referencing $auth and never PERMISSIONS FULL",
    async () => {
      const tables = parseTableBlocks(await readMergedSchema());
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        if (SEALED_TABLES.has(table.name) || table.name === AUDIT_TABLE) {
          continue;
        }
        expect(PERMISSIONS_RE.test(table.body)).toBe(true);
        expect(PERMISSIONS_FULL_RE.test(table.body)).toBe(false);
        expect(AUTH_REF_RE.test(table.body)).toBe(true);
      }
    }
  );

  acceptance(
    "admin/superadmin escalation keys on the GLOBAL role claim ($auth.role/$token.role), never the org member.role",
    async () => {
      const schema = await readMergedSchema();
      const tables = parseTableBlocks(schema);
      // At least one owner-data table escalates to admin/superadmin via the
      // global claim. No table may key its app-authz escalation on member.role.
      const escalating = tables.filter((t) =>
        GLOBAL_ROLE_CLAIM_RE.test(t.body)
      );
      expect(escalating.length).toBeGreaterThan(0);
      for (const table of tables) {
        expect(ORG_MEMBER_ROLE_RE.test(table.body)).toBe(false);
      }
    }
  );
});

describe("the audit table is append-only for every role including superadmin", () => {
  acceptance(
    "audit_log grants create + scoped select but denies update and delete to all roles",
    async () => {
      const tables = parseTableBlocks(await readMergedSchema());
      const audit = tables.find((t) => t.name === AUDIT_TABLE);
      expect(audit).toBeDefined();
      const body = (audit as TableBlock).body;
      // Append-only: a create grant exists; NO update/delete grant exists for any
      // role (the immutability floor — superadmin cannot rewrite audit).
      expect(FOR_CREATE_RE.test(body)).toBe(true);
      // The only update/delete mention permitted is `FOR update, delete NONE`.
      const hasUpdateDeleteNone = FOR_UPDATE_DELETE_NONE_RE.test(body);
      const hasBareUpdate = FOR_UPDATE_RE.test(body) && !hasUpdateDeleteNone;
      const hasBareDelete = FOR_DELETE_RE.test(body) && !hasUpdateDeleteNone;
      expect(hasUpdateDeleteNone).toBe(true);
      expect(hasBareUpdate).toBe(false);
      expect(hasBareDelete).toBe(false);
    }
  );
});

describe("the credential and delta-log tables stay sealed to record-access sessions", () => {
  acceptance(
    "the user credential table and document_delta are PERMISSIONS NONE with no FOR grant",
    async () => {
      const tables = parseTableBlocks(await readMergedSchema());
      for (const name of SEALED_TABLES) {
        const table = tables.find((t) => t.name === name);
        expect(table).toBeDefined();
        const body = (table as TableBlock).body;
        expect(PERMISSIONS_NONE_RE.test(body)).toBe(true);
        expect(ANY_FOR_GRANT_RE.test(body)).toBe(false);
      }
    }
  );
});
