import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the local store's security invariants, as a static
// source/schema scan (the live integration proofs stay in the acceptance suite).
//
// Promoted here so the meta-gate enforces them and a regression cannot slip past
// CI. Four detectors read the REAL files and assert:
//   1. surreal-http.ts + documents.local.ts import no SurrealDB SDK/WASM — the
//      daemon reaches SurrealDB over loopback HTTP via native fetch only.
//   2. documents.surql declares an explicit row-level PERMISSIONS clause on every
//      table: owner-data scoped to $auth, the credential + delta-log tables
//      sealed PERMISSIONS NONE, none left to the implicit (open) default.
//   3. the store query path is parameterized only — no template-literal or
//      string-concatenated SurrealQL (values travel as $vars / type:: ctors).
//   4. the query/CRUD path authenticates with a record-access Bearer session and
//      never reads the root credentials (SURREAL_USER / SURREAL_PASS); the check
//      runs over comment-stripped code so a stray comment can neither satisfy nor
//      trip it.
//
// The mutation twin (store-security.mutation.test.ts) plants a bad input into
// each detector and proves it reddens, with a clean control that stays green.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/data/src/conformance
const DATA_SRC = resolve(HERE, ".."); // packages/data/src
const HTTP_FILE = resolve(DATA_SRC, "surreal-http.ts");
const LOCAL_FILE = resolve(DATA_SRC, "documents.local.ts");
const SCHEMA_FILE = resolve(
  DATA_SRC,
  "..",
  "..",
  "db",
  "database",
  "schema",
  "documents.surql"
);

const read = (path: string): string => readFileSync(path, "utf8");

// --- Detector 1: no SurrealDB SDK / WASM imports ---

const IMPORT_SPECIFIER_RE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

const isForbiddenSurrealSdk = (specifier: string): boolean =>
  specifier === "surrealdb" ||
  specifier === "surrealdb.js" ||
  specifier.startsWith("@surrealdb/");

const findSdkImports = (source: string): string[] => {
  const hits: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier !== undefined && isForbiddenSurrealSdk(specifier)) {
      hits.push(specifier);
    }
  }
  return hits;
};

// --- Detector 2: explicit row-level PERMISSIONS on every schema table ---

const DEFINE_TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|$)/gi;
const SURQL_COMMENT_RE = /--[^\n]*/g;
const PERMISSIONS_RE = /\bPERMISSIONS\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const PERMISSIONS_NONE_RE = /\bPERMISSIONS\s+NONE\b/i;
const AUTH_REF_RE = /\$auth\b/i;

// Owner-data tables must scope to the authenticated record; the credential table,
// the delta-log, and the materialized projection must be fully denied to
// record-access sessions (the delta-log and the projection are the two copies the
// cross-scope perimeter seals so a scoped session reads zero rows directly).
const OWNER_SCOPED_TABLES = ["documents"] as const;
const SEALED_TABLES = [
  "user",
  "document_delta",
  "document_projection",
] as const;

interface TableBlock {
  readonly body: string;
  readonly name: string;
}

const parseTableBlocks = (schema: string): TableBlock[] => {
  const blocks: TableBlock[] = [];
  // Strip SurrealQL line comments first so prose like "DEFINE TABLE foo" inside a
  // comment can never be mistaken for a real table declaration.
  const code = schema.replace(SURQL_COMMENT_RE, "");
  for (const match of code.matchAll(DEFINE_TABLE_RE)) {
    const name = match[1];
    if (name !== undefined) {
      blocks.push({ name, body: match[0] });
    }
  }
  return blocks;
};

const findSchemaViolations = (schema: string): string[] => {
  const violations: string[] = [];
  const tables = parseTableBlocks(schema);
  const byName = new Map(tables.map((table) => [table.name, table]));

  // No table may default open (missing PERMISSIONS) or be PERMISSIONS FULL.
  for (const table of tables) {
    if (!PERMISSIONS_RE.test(table.body)) {
      violations.push(`${table.name}: no explicit PERMISSIONS (defaults open)`);
    }
    if (PERMISSIONS_FULL_RE.test(table.body)) {
      violations.push(`${table.name}: PERMISSIONS FULL`);
    }
  }

  // Owner-data tables must be $auth-scoped.
  for (const name of OWNER_SCOPED_TABLES) {
    const table = byName.get(name);
    if (table === undefined) {
      violations.push(`missing owner-data table: ${name}`);
    } else if (!AUTH_REF_RE.test(table.body)) {
      violations.push(`${name}: not $auth-scoped`);
    }
  }

  // Credential + delta-log tables must be sealed PERMISSIONS NONE.
  for (const name of SEALED_TABLES) {
    const table = byName.get(name);
    if (table === undefined) {
      violations.push(`missing sealed table: ${name}`);
    } else if (!PERMISSIONS_NONE_RE.test(table.body)) {
      violations.push(`${name}: not PERMISSIONS NONE`);
    }
  }

  return violations;
};

// --- Detector 3: parameterized queries only (no interpolated SurrealQL) ---

// A SurrealQL keyword sharing a line with a `${…}` template interpolation, or
// adjacent to a `+` string concatenation, is the forbidden injection surface.
const SQL_TEMPLATE_INTERP_RE =
  /(?:SELECT|CREATE|UPDATE|DELETE|RELATE|INSERT|UPSERT)\b[^`]*\$\{/i;
const SQL_CONCAT_LEFT_RE =
  /["'][^"']*\b(?:SELECT|CREATE|UPDATE|DELETE|RELATE|INSERT|UPSERT)\b[^"']*["']\s*\+/i;
const SQL_CONCAT_RIGHT_RE =
  /\+\s*["'][^"']*\b(?:SELECT|CREATE|UPDATE|DELETE|RELATE|INSERT|UPSERT)\b/i;

const findInterpolatedQueries = (source: string): string[] => {
  const offenders: string[] = [];
  for (const line of source.split("\n")) {
    if (
      SQL_TEMPLATE_INTERP_RE.test(line) ||
      SQL_CONCAT_LEFT_RE.test(line) ||
      SQL_CONCAT_RIGHT_RE.test(line)
    ) {
      offenders.push(line.trim());
    }
  }
  return offenders;
};

// --- Detector 4: Bearer-not-root in the query path (comment-resistant) ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
// Strip line comments, but not the `//` inside a `://` URL scheme.
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const BASIC_AUTH_RE = /kind\s*:\s*["']basic["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;

const usesBearerAuth = (source: string): boolean =>
  BEARER_AUTH_RE.test(stripJsComments(source));

const usesBasicAuth = (source: string): boolean =>
  BASIC_AUTH_RE.test(stripJsComments(source));

const findRootCredentialReads = (source: string): string[] => {
  const code = stripJsComments(source);
  const hits: string[] = [];
  for (const re of ROOT_CREDENTIAL_RES) {
    if (re.test(code)) {
      hits.push(re.source);
    }
  }
  return hits;
};

describe("the local store's security invariants hold at the source/schema layer", () => {
  test("the local store graph imports no SurrealDB SDK or WASM — HTTP-only access", () => {
    expect(findSdkImports(read(HTTP_FILE))).toEqual([]);
    expect(findSdkImports(read(LOCAL_FILE))).toEqual([]);
  });

  test("every schema table declares explicit row-level PERMISSIONS — owner-data $auth-scoped, credential + delta-log + projection sealed NONE, none default open", () => {
    expect(findSchemaViolations(read(SCHEMA_FILE))).toEqual([]);
  });

  test("the store query path is parameterized only — no template-literal or concatenated SurrealQL", () => {
    expect(findInterpolatedQueries(read(HTTP_FILE))).toEqual([]);
    expect(findInterpolatedQueries(read(LOCAL_FILE))).toEqual([]);
  });

  test("the query/CRUD path uses a record-access Bearer session and reads no root credentials", () => {
    const localCode = read(LOCAL_FILE);
    // Comment-stripped: a `// Bearer …` line cannot satisfy this, and the actual
    // object-literal auth selection must be present.
    expect(usesBearerAuth(localCode)).toBe(true);
    // The query path never constructs a Basic/root session.
    expect(usesBasicAuth(localCode)).toBe(false);
    // Neither the query path nor the transport reads the root env credentials.
    expect(findRootCredentialReads(localCode)).toEqual([]);
    expect(findRootCredentialReads(read(HTTP_FILE))).toEqual([]);
  });
});
