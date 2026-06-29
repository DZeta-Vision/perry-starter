// The pinned, enumerated rename manifest — the SINGLE source both the rename
// script (`scripts/rename.mjs`) and the rename-convergence smoke gate read. It
// is a fixed, enumerated SET (not prose), so two renames converge: a second run
// finds no token left to rewrite.
//
// Two token families are renamed: the `perry-starter` package/identity family
// and the `document`/`documents` reference-entity noun. `PERRY_TARGET` itself
// (the env-var name and the `local-sidecar`/`cloud-relay` enum) is a
// framework-owned literal and is NOT renamed; its category exists only to assert
// no `perry-starter`/`document` token rides along in the seam files.
//
// Dependency-free: this module exports plain data only. It deliberately exports
// NO `generate`/`scaffold` function — the deliverable is a thin identifier
// rewrite over the existing tree, never a project generator.

// Directories the rename walk never descends into: version control, installed
// dependencies, build outputs, and local/ephemeral tool state. Renaming inside
// any of these would corrupt regenerated artifacts or third-party code.
export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".source",
  ".turbo",
  ".vite",
  ".cache",
  "coverage",
  ".nyc_output",
  ".tanstack",
  ".wrangler",
  ".alchemy",
  ".surrealkit-staging",
  "out",
  ".output",
  "tmp",
  "temp",
  ".idea",
  ".vscode",
  // Planning / tooling state that is gitignored in the template and never
  // shipped to an adopter who clones the tracked tree.
  "_bmad",
  "_bmad-output",
  "skills",
  "forge-data",
  "_skf-learn",
  "_ucg-learn",
  "graphify-out",
  ".cocoindex_code",
  ".claude",
  ".cursor",
  ".agents",
];

// The reference-entity layers. Inside these the `document`/`documents` noun is
// rewritten broadly (table, registry key, store impls, the canonical shapes,
// the daemon read route, and the file basenames). Everywhere else only the
// narrow entity contexts (registry key, route path, module specifier) are
// rewritten, so unrelated `document` identifiers — most importantly the
// `RootDocument` HTML-shell component and the DOM `document` global — are never
// touched.
export const ENTITY_DIRS = [
  "packages/db/database",
  "packages/db/src",
  "packages/data/src",
  "apps/daemon/src",
];

export const ENTITY_FILES = [
  "packages/db/package.json",
  "packages/data/package.json",
];

export const renameManifest = {
  categories: [
    {
      id: "package-scope",
      description:
        "the @perry-starter/* workspace scope across every package.json name, " +
        "workspace dependency, and tsconfig path",
      tokens: ["@perry-starter"],
      globs: ["**/package.json", "**/tsconfig*.json", "**/*.ts", "**/*.tsx"],
    },
    {
      id: "root-identity",
      description:
        "the root `perry-starter` workspace identity (root package.json name, " +
        "lockfile, bts manifest, README heading)",
      tokens: ["perry-starter"],
      globs: ["package.json", "bun.lock", "bts.jsonc", "README.md"],
    },
    {
      id: "apps",
      description:
        "the apps/* package and directory names — asserted to carry no " +
        "perry-starter/document token (the app names are plain)",
      tokens: ["perry-starter"],
      globs: ["apps/*/package.json"],
    },
    {
      id: "deploy-ids",
      description:
        "the one canonical deploy base identifier (the Alchemy app id and the " +
        "Worker/DO base) from which the per-env namespaces derive",
      tokens: ["perry-starter"],
      globs: ["packages/infra/alchemy.run.ts"],
    },
    {
      id: "perry-target-wiring",
      description:
        "the PERRY_TARGET build seam files — the PERRY_TARGET literal is " +
        "framework-owned and NOT renamed; this category only asserts no " +
        "perry-starter/document token rides along in the seam",
      tokens: ["perry-starter"],
      globs: ["turbo.json", "**/vite.config.ts", "packages/env/src/**"],
    },
    {
      id: "documents-entity",
      description:
        "the document/documents reference-entity noun at every layer: the " +
        "SurrealQL table and delta/projection tables, the collaboration-mode " +
        "registry key, the canonical Zod shapes, the data-store impls, the " +
        "package exports, and the (forward-looking) route path and UI string",
      tokens: ["documents", "document"],
      globs: [...ENTITY_DIRS, ...ENTITY_FILES],
    },
  ],
};
