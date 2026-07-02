#!/usr/bin/env node
// The thin, scripted `perry rename <domain>` — a dependency-free identifier
// rewrite over the existing tree (mirroring scripts/meta-gate.mjs +
// scripts/tier-boundary-guard.mjs). It rewrites the `perry-starter` package /
// identity / deploy-id family and the `document`/`documents` reference-entity
// noun to `<domain>`, then renames the entity file basenames. It is NOT a
// project generator: there is no template expansion and no scaffolding step.
//
// PerryTS note: the `perry` CLI has a fixed subcommand set with no `rename`
// subcommand and no plugin hook, so the adopter-facing `perry rename <domain>`
// is delivered as this repo script (`bun run rename <domain>`), not a real
// `perry` subcommand or a `perry`-named bin (which would collide on PATH).
//
// Convergent + idempotent: a second run on an already-renamed tree is a no-op.
// The manifest (scripts/rename-manifest.mjs) is the single source this script
// and the rename-convergence smoke gate both read.
//
// Dependency-free: imports only node builtins plus the sibling manifest.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ENTITY_DIRS,
  ENTITY_FILES,
  EXCLUDED_DIRS,
} from "./rename-manifest.mjs";

const EXCLUDED = new Set(EXCLUDED_DIRS);

// A valid domain is a lowercase npm-scope-safe token, so the rewritten
// `@<domain>/*` scope and package names resolve.
const VALID_DOMAIN = /^[a-z][a-z0-9-]*$/;

// The `perry-starter` family — a plain substring so `@perry-starter/db`, the
// root `perry-starter` identity, and the `perry-starter`-based deploy id all
// converge in one pass.
const PERRY_STARTER = /perry-starter/gi;

// Narrow `document(s)`-entity contexts applied everywhere. Each rewrites ONLY
// the entity token in a syntactic position the entity occupies — never a bare
// `document` word — so the DOM `document` global and `RootDocument` are safe.
const ENTITY_REGISTRY_KEY = /\bdocuments(?=\s*:\s*["'])/g; // `documents: "private"`
const ENTITY_ROUTE_PATH = /(["'`]\/)documents(?=["'`])/g; // `"/documents"`
const ENTITY_MODULE_FILE = /\bdocuments(?=\.(?:ts|local\.ts|cloud\.ts)\b)/g; // `documents.local.ts`

// Broad `document(s)` rewrite, applied ONLY inside the reference-entity layers
// (no DOM code lives there). Word-boundaried so `RootDocument`,
// `DocumentRecord`, and `documentSchema` (which keep their cross-package names)
// are never matched; the compound rule handles `document_delta` /
// `document-projection`.
const ENTITY_WORD_COMPOUND = /\b(documents?)([_-])/gi;
const ENTITY_WORD = /\bdocuments?\b/gi;

// Basenames that embed an entity token, used to rename files after the content
// rewrite.
const ENTITY_BASENAME = /\bdocuments?\b/i;

// Skip true binaries (none in the tracked tree, but be defensive on a real
// working tree): a NUL byte in the head is the binary signal.
const isBinary = (buffer) => buffer.includes(0, 0);

const matchCase = (source, replacement) => {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
};

const toPosix = (path) => path.split(sep).join("/");

const isEntityScope = (relPath) => {
  const posix = toPosix(relPath);
  if (ENTITY_FILES.includes(posix)) {
    return true;
  }
  return ENTITY_DIRS.some(
    (dir) => posix === dir || posix.startsWith(`${dir}/`)
  );
};

const rewriteContent = (text, relPath, domain) => {
  let out = text.replace(PERRY_STARTER, (m) => matchCase(m, domain));
  out = out.replace(ENTITY_REGISTRY_KEY, domain);
  out = out.replace(ENTITY_ROUTE_PATH, (_m, prefix) => `${prefix}${domain}`);
  out = out.replace(ENTITY_MODULE_FILE, domain);
  if (isEntityScope(relPath)) {
    out = out.replace(
      ENTITY_WORD_COMPOUND,
      (_m, token, separator) => matchCase(token, domain) + separator
    );
    out = out.replace(ENTITY_WORD, (m) => matchCase(m, domain));
  }
  return out;
};

const rewriteBasename = (name, domain) => {
  let out = name.replace(PERRY_STARTER, (m) => matchCase(m, domain));
  out = out.replace(
    ENTITY_WORD_COMPOUND,
    (_m, token, separator) => matchCase(token, domain) + separator
  );
  out = out.replace(ENTITY_WORD, (m) => matchCase(m, domain));
  return out;
};

const walk = (dir, out) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED.has(entry.name)) {
        walk(join(dir, entry.name), out);
      }
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
};

const valueAfter = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

// Prefer the git-tracked file set when the root is a git repo, so no gitignored
// directory (build output, local tool state) can ever be walked or rewritten —
// the denylist walk is the fallback for a non-git tree (e.g. an extracted
// tarball, or the gate's temp-tree copy).
const collectFiles = (root) => {
  if (existsSync(join(root, ".git"))) {
    try {
      return execFileSync("git", ["ls-files", "-z"], { cwd: root })
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((rel) => join(root, rel))
        .filter((file) => existsSync(file));
    } catch {
      // Fall through to the filesystem walk if git is unavailable.
    }
  }
  const out = [];
  walk(root, out);
  return out;
};

const main = () => {
  const argv = process.argv.slice(2);
  const domain = argv.find((arg) => !arg.startsWith("-"));
  const rootArg = valueAfter(argv, "--root");
  const root = resolve(rootArg ?? process.cwd());

  if (!domain) {
    process.stderr.write(
      "perry rename: missing <domain>. Usage: bun run rename <domain>\n"
    );
    process.exit(1);
    return;
  }
  if (!VALID_DOMAIN.test(domain)) {
    process.stderr.write(
      `perry rename: invalid domain "${domain}" — use a lowercase token like "acme" or "my-app".\n`
    );
    process.exit(1);
    return;
  }

  // Destructive-tree fence: this tool rewrites file contents and renames files
  // in place at `root`. When `root` is a real git working tree (a `.git` entry
  // exists), refuse unless `--confirm` is passed — so an accidental direct
  // `node scripts/rename.mjs` can never rewrite the live repo. The documented
  // path (`bun run rename <domain>`) passes `--confirm`; the gate/twin tests run
  // it on a temp copy that has no `.git`, so they are unaffected.
  if (existsSync(join(root, ".git")) && !argv.includes("--confirm")) {
    process.stderr.write(
      "perry rename: refusing to rewrite the live git working tree without --confirm.\n" +
        "This rewrites/renames files in place. Run its .gate.test.ts to exercise it\n" +
        "safely (temp copy), or run `bun run rename <domain>` to do it on purpose.\n"
    );
    process.exit(1);
    return;
  }

  const files = collectFiles(root);

  // Pass 1: rewrite file contents in place (paths unchanged).
  let rewritten = 0;
  for (const file of files) {
    const buffer = readFileSync(file);
    if (isBinary(buffer)) {
      continue;
    }
    const text = buffer.toString("utf8");
    const next = rewriteContent(text, relative(root, file), domain);
    if (next !== text) {
      writeFileSync(file, next);
      rewritten += 1;
    }
  }

  // Pass 2: rename entity file basenames (deepest first so parent paths stay
  // valid). Only files inside the entity layers are eligible, so unrelated
  // files that merely contain the substring are never moved.
  const renames = files
    .filter(
      (file) =>
        isEntityScope(relative(root, file)) &&
        ENTITY_BASENAME.test(basename(file))
    )
    .sort((a, b) => b.length - a.length);
  let moved = 0;
  for (const file of renames) {
    const nextName = rewriteBasename(basename(file), domain);
    if (nextName !== basename(file)) {
      renameSync(file, join(dirname(file), nextName));
      moved += 1;
    }
  }

  process.stdout.write(
    `perry rename: rewrote ${rewritten} file(s) and renamed ${moved} entity file(s) to "${domain}".\n`
  );
};

main();
