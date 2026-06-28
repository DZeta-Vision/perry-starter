#!/usr/bin/env node
// The SINGLE documented step that removes the generic `documents` reference
// entity end to end (`bun run remove-reference`), leaving an internally
// CONSISTENT tree: after it runs, no surviving module, test, or fixture imports
// or names the removed entity, so the remaining tree still type-checks and
// collects.
//
// It does four things, in order, over the tree at `--root` (defaults to cwd):
//   1. RE-POINT the two generic db conformance gates that exercise several
//      canonical shapes (documents being one of them) so their coverage of the
//      SURVIVING shapes is preserved rather than thrown away.
//   2. DELETE the entity's own modules (the db `documents` export, the data
//      store impls, the daemon reference read route).
//   3. EDIT the producers: drop the `documents` package exports, strip the
//      SurrealQL `documents`/`document_delta` tables (the credential/access
//      perimeter is preserved), empty the collaboration-mode registry, and
//      un-wire the daemon read route + the schema-doc reference.
//   4. SWEEP every remaining test / fixture that still references the documents
//      family — these exist only to exercise the removed entity.
//
// Dependency-free: node builtins only. Each step is guarded so it is safe to
// re-run.

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

// The rename/removal META-TOOLING is template machinery (it necessarily names
// the entity to find/rewrite it) — never a product consumer. It is excluded
// from the consumer sweep so removing the reference entity never deletes the
// rename/removal scripts or their gate/twin tests.
const META_TOOLING = new Set([
  "scripts/rename.mjs",
  "scripts/remove-reference.mjs",
  "scripts/rename-manifest.mjs",
  "scripts/rename.gate.test.ts",
  "scripts/rename.mutation.test.ts",
  "scripts/remove-reference.gate.test.ts",
  "scripts/remove-reference.mutation.test.ts",
  "scripts/thin-rename-scope.gate.test.ts",
  "scripts/thin-rename-scope.mutation.test.ts",
]);

// Step 1 — re-points. Exact-text edits on the two generic db gates: drop the
// `documents` import and the `documents` case, keeping the delta-envelope /
// document-projection / audit-entry / collaboration-mode cases intact.
const REPOINTS = [
  {
    file: "packages/db/src/conformance/hand-authored-zod.gate.test.ts",
    edits: [
      'import { documentsEntitySchema } from "../documents";\n',
      '  {\n    name: "documents entity",\n    schema: documentsEntitySchema as RuntimeSchema,\n    valid: {\n      doc_id: ULID_A,\n      scope_user_id: ULID_B,\n      title: "Untitled",\n      body_preview: "A generic document body preview.",\n    },\n  },\n',
    ],
  },
  {
    file: "packages/db/src/conformance/naming-conventions.gate.test.ts",
    edits: [
      'import { documentsEntitySchema } from "../documents";\n',
      "  documentsEntitySchema,\n",
    ],
  },
];

// Step 2 — the entity's own modules.
const CORE_DELETIONS = [
  "packages/db/src/documents.ts",
  "packages/data/src/documents.ts",
  "packages/data/src/documents.local.ts",
  "packages/data/src/documents.cloud.ts",
  "apps/daemon/src/documents-read.ts",
];

// Step 3 — producer edits.
const DB_EXPORTS_TO_DROP = ["./documents"];
const DATA_EXPORTS_TO_DROP = [
  ".",
  "./documents",
  "./documents.local",
  "./documents.cloud",
];

const SURQL_ENTITY_MARKER = "-- The documents entity";
const SURQL_HEADER =
  "-- Merged local data-engine schema for the documents entity.";
const SURQL_HEADER_REPLACEMENT =
  "-- Merged local data-engine schema (auth + credential perimeter).";

const REGISTRY_LITERAL = /Object\.freeze\(\{[\s\S]*?\}\s*as const\)/;
const REGISTRY_EMPTY = "Object.freeze({} as const)";
const REGISTRY_COMMENT = " The generic `documents` collection has an entry.";

const SETUP_SCHEMA_REF =
  "the documents schema in schema/documents.surql carries";
const SETUP_SCHEMA_REPLACEMENT = "the access/credential schema carries";

// Step 4 — sweep patterns: every form a `documents`-entity reference takes
// (kept in sync with scripts/remove-reference.gate.test.ts). A test or fixture
// matching any of these exists only to exercise the removed entity.
const DOC_REFERENCE_PATTERNS = [
  /DEFINE\s+TABLE\s+documents\b/i,
  /@perry-starter\/db\/documents\b/,
  /(?:from|import\()\s*["']@perry-starter\/data["']/,
  /@perry-starter\/data\/documents(?:\.local|\.cloud)?\b/,
  /\bdocuments\s*:\s*["']/,
  /["'`]\/documents["'`]/,
  /\bdocuments\.(?:surql|ts|local\.ts|cloud\.ts)\b/,
  /\bdocumentsEntitySchema\b/,
  /\bcreateDocumentsLocal\b/,
  /\bdocumentsData\b/,
  /collaborationModeRegistry\.documents\b/,
];

const SKIP_DIRS = new Set(["node_modules", ".git"]);

const readDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walk = (dir, out) => {
  for (const entry of readDir(dir)) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), out);
      }
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
};

const editFile = (root, rel, edits) => {
  const path = join(root, rel);
  if (!existsSync(path)) {
    return;
  }
  let text = readFileSync(path, "utf8");
  for (const target of edits) {
    text = text.replace(target, "");
  }
  writeFileSync(path, text);
};

const deleteFiles = (root, rels) => {
  for (const rel of rels) {
    const path = join(root, rel);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
};

const dropExports = (root, rel, keys) => {
  const path = join(root, rel);
  if (!existsSync(path)) {
    return;
  }
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.exports) {
    for (const key of keys) {
      delete pkg.exports[key];
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
};

const stripSchema = (root) => {
  const path = join(root, "packages/db/database/schema/documents.surql");
  if (!existsSync(path)) {
    return;
  }
  let text = readFileSync(path, "utf8");
  const marker = text.indexOf(SURQL_ENTITY_MARKER);
  if (marker !== -1) {
    text = `${text.slice(0, marker).trimEnd()}\n`;
  }
  text = text.replace(SURQL_HEADER, SURQL_HEADER_REPLACEMENT);
  writeFileSync(path, text);
};

const emptyRegistry = (root) => {
  const path = join(root, "packages/db/src/collaboration-mode.ts");
  if (!existsSync(path)) {
    return;
  }
  let text = readFileSync(path, "utf8");
  text = text.replace(REGISTRY_LITERAL, REGISTRY_EMPTY);
  text = text.replace(REGISTRY_COMMENT, "");
  writeFileSync(path, text);
};

const fixSchemaDoc = (root) => {
  const path = join(root, "packages/db/database/setup.surql");
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8").replace(
    SETUP_SCHEMA_REF,
    SETUP_SCHEMA_REPLACEMENT
  );
  writeFileSync(path, text);
};

const unwireDaemon = (root) => {
  const path = join(root, "apps/daemon/src/main.ts");
  if (!existsSync(path)) {
    return;
  }
  let text = readFileSync(path, "utf8");
  text = text.replace(
    'import { registerDocumentsRead } from "./documents-read";\n',
    ""
  );
  text = text.replace(
    'const SURREAL_NS = "perry";\nconst SURREAL_DB = "perry";\n',
    ""
  );
  text = text.replace(
    "const sidecar = await startSupervisor({",
    "await startSupervisor({"
  );
  text = text.replace(
    "  registerDocumentsRead(app, {\n    url: sidecar.url,\n    ns: SURREAL_NS,\n    db: SURREAL_DB,\n  });\n",
    ""
  );
  writeFileSync(path, text);
};

const isSweepable = (path) =>
  path.endsWith(".test.ts") || path.includes(`${"__fixtures__"}/`);

const referencesEntity = (text) =>
  DOC_REFERENCE_PATTERNS.some((pattern) => pattern.test(text));

const sweepConsumers = (root) => {
  const files = [];
  walk(root, files);
  let swept = 0;
  for (const file of files) {
    if (META_TOOLING.has(relative(root, file))) {
      continue;
    }
    if (isSweepable(file) && referencesEntity(readFileSync(file, "utf8"))) {
      rmSync(file, { force: true });
      swept += 1;
    }
  }
  return swept;
};

const valueAfter = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

const main = () => {
  const argv = process.argv.slice(2);
  const root = resolve(valueAfter(argv, "--root") ?? process.cwd());

  for (const { file, edits } of REPOINTS) {
    editFile(root, file, edits);
  }
  deleteFiles(root, CORE_DELETIONS);
  dropExports(root, "packages/db/package.json", DB_EXPORTS_TO_DROP);
  dropExports(root, "packages/data/package.json", DATA_EXPORTS_TO_DROP);
  stripSchema(root);
  emptyRegistry(root);
  fixSchemaDoc(root);
  unwireDaemon(root);
  const swept = sweepConsumers(root);

  process.stdout.write(
    `remove-reference: removed the documents reference entity in one step (swept ${swept} consumer file(s)).\n`
  );
};

main();
