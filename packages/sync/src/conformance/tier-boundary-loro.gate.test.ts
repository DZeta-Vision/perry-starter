import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the tier-boundary build guard must fail the daemon build on
// ANY transitive import of the CRDT engine (loro-crdt) or raw WASM into the
// daemon graph. Loro is browser/sidecar-only; the daemon transports the opaque
// base64 payload and never imports, decodes, or materializes Loro.
//
// The guard (`scripts/tier-boundary-guard.mjs`) scans the daemon-graph roots
// (apps/daemon, packages/data/src, packages/ai/src). This gate proves the guard:
//   - exits 0 on the real, clean daemon graph (anti-vacuous: not always-red);
//   - exits non-zero on a synthetic daemon file importing `loro-crdt`;
//   - exits non-zero on a synthetic daemon file importing a `.wasm` asset;
//   - exits non-zero on an optional/dev-style transitive Loro import; and
//   - exits non-zero on a NON-LITERAL dynamic import() of a Loro specifier.
//
// Synthetic roots are built in an OS temp dir and removed in finally — nothing is
// ever written under the repo tree.
//
// DEFERRED to Execute (the guard-script wiring, NOT authored here): add
// `loro-crdt` to the daemon denylist; extend the scan to the full resolved
// dependency closure (optionalDeps/devDeps); ban non-literal dynamic specifiers
// in the daemon graph; promote the guard to a blocking merge gate.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/sync/src/conformance
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");

// Assemble the engine specifier at runtime (never a contiguous literal) so the
// repo scan never trips on this test file's own source.
const LORO_ENGINE = ["loro", "crdt"].join("-");

const daemonImport = (specifier: string): string =>
  [
    `import * as engine from ${JSON.stringify(specifier)};`,
    "export const leaked = engine;",
    "",
  ].join("\n");

const daemonDynamicImport = (specifier: string): string =>
  [
    `const name = ${JSON.stringify(specifier)};`,
    "export const leaked = () => import(name);",
    "",
  ].join("\n");

const BENIGN_DAEMON_SOURCE = [
  'import { z } from "zod";',
  "export const ok = z;",
  "",
].join("\n");

interface PlantedFile {
  contents: string;
  relPath: string;
}

const makeSyntheticRoot = (files: readonly PlantedFile[]): string => {
  const root = mkdtempSync(join(tmpdir(), "perry-sync-loro-tier-root-"));
  for (const file of files) {
    const full = join(root, file.relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.contents);
  }
  return root;
};

const runGuard = (args: string[]): number => {
  try {
    execFileSync(process.execPath, [GUARD, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
};

const DAEMON_FILE = join("apps", "daemon", "src", "leak.ts");

describe("the tier-boundary guard fails the daemon build on any Loro/WASM import", () => {
  test("the guard exits 0 on the real, clean daemon graph (not always-red)", () => {
    expect(runGuard(["--root", REPO_ROOT])).toBe(0);
  });

  test("a synthetic daemon file importing the loro CRDT engine makes the guard exit non-zero", () => {
    const root = makeSyntheticRoot([
      { contents: daemonImport(LORO_ENGINE), relPath: DAEMON_FILE },
    ]);
    try {
      expect(runGuard(["--root", root])).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a synthetic daemon file importing a raw .wasm asset makes the guard exit non-zero", () => {
    const root = makeSyntheticRoot([
      { contents: daemonImport("./loro_wasm_bg.wasm"), relPath: DAEMON_FILE },
    ]);
    try {
      expect(runGuard(["--root", root])).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a synthetic daemon file with an optional/dev-style transitive loro engine import is caught", () => {
    const root = makeSyntheticRoot([
      {
        contents: daemonImport(`${LORO_ENGINE}/nodejs`),
        relPath: join("packages", "data", "src", "leak.ts"),
      },
    ]);
    try {
      expect(runGuard(["--root", root])).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a synthetic daemon file with a NON-LITERAL dynamic import of the loro engine is caught", () => {
    const root = makeSyntheticRoot([
      { contents: daemonDynamicImport(LORO_ENGINE), relPath: DAEMON_FILE },
    ]);
    try {
      expect(runGuard(["--root", root])).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a clean synthetic daemon file importing only a benign dep exits 0", () => {
    const root = makeSyntheticRoot([
      { contents: BENIGN_DAEMON_SOURCE, relPath: DAEMON_FILE },
    ]);
    try {
      expect(runGuard(["--root", root])).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
