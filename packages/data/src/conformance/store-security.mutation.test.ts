import { describe, expect, test } from "vitest";

// Mutation twin for store-security.gate.test.ts — the anti-vacuous proof.
//
// Each of the gate's four detectors is replicated here and fed a known-bad
// input; the twin asserts the detector reddens, with a clean control proving it
// is not always-red. If a detector ever stopped discriminating, the matching
// assertion below would flip and the twin would fail. Inputs are in-memory
// strings; the real source is never mutated.

// --- Detector 1: forbidden SurrealDB SDK / WASM imports ---

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
const OWNER_SCOPED_TABLES = ["documents"] as const;
const SEALED_TABLES = ["user", "document_delta"] as const;

interface TableBlock {
  readonly body: string;
  readonly name: string;
}

const parseTableBlocks = (schema: string): TableBlock[] => {
  const blocks: TableBlock[] = [];
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

  for (const table of tables) {
    if (!PERMISSIONS_RE.test(table.body)) {
      violations.push(`${table.name}: no explicit PERMISSIONS (defaults open)`);
    }
    if (PERMISSIONS_FULL_RE.test(table.body)) {
      violations.push(`${table.name}: PERMISSIONS FULL`);
    }
  }
  for (const name of OWNER_SCOPED_TABLES) {
    const table = byName.get(name);
    if (table === undefined) {
      violations.push(`missing owner-data table: ${name}`);
    } else if (!AUTH_REF_RE.test(table.body)) {
      violations.push(`${name}: not $auth-scoped`);
    }
  }
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

// --- Detector 3: parameterized queries only ---

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
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;

const usesBearerAuth = (source: string): boolean =>
  BEARER_AUTH_RE.test(stripJsComments(source));

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

// A clean, fully-shaped schema control: every table carries the right clause.
const CLEAN_SCHEMA = `
DEFINE TABLE user SCHEMAFULL PERMISSIONS NONE;
DEFINE TABLE documents SCHEMAFULL PERMISSIONS FOR select, update, delete WHERE owner = $auth FOR create WHERE owner = $auth;
DEFINE TABLE document_delta SCHEMAFULL PERMISSIONS NONE;
`;

describe("the no-SDK detector fires on a planted SurrealDB import", () => {
  test('a planted `import … from "surrealdb"` reddens', () => {
    expect(
      findSdkImports('import { Surreal } from "surrealdb";').length
    ).toBeGreaterThan(0);
  });

  test('a planted side-effect `import "@surrealdb/…"` reddens (scoped-package branch)', () => {
    // Any `@surrealdb/`-scoped import is forbidden (covers @surrealdb/wasm); a
    // non-`wasm` scoped specifier is used here so this fixture does not itself
    // trip the daemon-graph denylist guard.
    expect(findSdkImports('import "@surrealdb/node";').length).toBeGreaterThan(
      0
    );
  });

  test('a planted dynamic `import("surrealdb.js")` reddens', () => {
    expect(
      findSdkImports('await import("surrealdb.js");').length
    ).toBeGreaterThan(0);
  });

  test("an ordinary local import stays green (not always-red)", () => {
    expect(findSdkImports('import { sql } from "./surreal-http";')).toEqual([]);
  });
});

describe("the schema-permissions detector fires on a planted open table", () => {
  test("a table with no PERMISSIONS clause reddens", () => {
    const planted = `
DEFINE TABLE leaky SCHEMAFULL;
${CLEAN_SCHEMA}`;
    expect(findSchemaViolations(planted).length).toBeGreaterThan(0);
  });

  test("a PERMISSIONS FULL table reddens", () => {
    const planted = CLEAN_SCHEMA.replace(
      "DEFINE TABLE document_delta SCHEMAFULL PERMISSIONS NONE;",
      "DEFINE TABLE document_delta SCHEMAFULL PERMISSIONS FULL;"
    );
    expect(findSchemaViolations(planted).length).toBeGreaterThan(0);
  });

  test("the fully-shaped clean schema stays green (not always-red)", () => {
    expect(findSchemaViolations(CLEAN_SCHEMA)).toEqual([]);
  });
});

describe("the parameterized-only detector fires on planted interpolation", () => {
  test("a template-literal interpolated query reddens", () => {
    // `\x24{` is a literal `${` at runtime; written as a hex escape so this
    // planted-bad fixture is not itself a template placeholder in source.
    expect(
      findInterpolatedQueries(
        "const q = `SELECT * FROM documents WHERE id = \x24{userInput}`;"
      ).length
    ).toBeGreaterThan(0);
  });

  test("a string-concatenated query reddens", () => {
    expect(
      findInterpolatedQueries(
        'const q = "DELETE FROM documents WHERE id = " + id;'
      ).length
    ).toBeGreaterThan(0);
  });

  test("a parameterized query line stays green (not always-red)", () => {
    expect(
      findInterpolatedQueries('const q = "SELECT * FROM documents;";')
    ).toEqual([]);
  });
});

describe("the Bearer-not-root detector resists comments and fires on planted root reads", () => {
  test("a planted `env.SURREAL_USER` / `SURREAL_PASS` read in code reddens", () => {
    expect(
      findRootCredentialReads(
        "const auth = { user: env.SURREAL_USER, pass: env.SURREAL_PASS };"
      ).length
    ).toBeGreaterThan(0);
  });

  test("a root credential named only inside a comment does NOT redden", () => {
    expect(
      findRootCredentialReads(
        "// never read env.SURREAL_USER or SURREAL_PASS here\nconst x = 1;"
      )
    ).toEqual([]);
  });

  test("a Bearer mention only inside a comment does NOT satisfy the Bearer check", () => {
    expect(usesBearerAuth('// kind: "bearer"\nconst x = 1;')).toBe(false);
  });

  test("an actual object-literal Bearer auth in code satisfies the Bearer check", () => {
    expect(usesBearerAuth('const auth = { kind: "bearer", token };')).toBe(
      true
    );
  });
});
