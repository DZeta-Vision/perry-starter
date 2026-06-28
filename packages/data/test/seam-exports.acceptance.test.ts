import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The packages/data and packages/ai seam packages each define one interface plus
// *.local.ts/*.cloud.ts implementation entrypoints. Per-target conditional
// exports physically EXCLUDE the unselected implementation (the local bundle
// carries only *.local.ts, the cloud bundle only *.cloud.ts), and app/UI/auth
// code imports only the seam interface — never a concrete impl, with no runtime
// target branch.
//
// package.json reads use node:fs inside the test bodies; impl modules are
// imported via variable specifiers so this file collects cleanly.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const DATA_LOCAL_MODULE = "@perry-starter/data/documents.local";
const DATA_CLOUD_MODULE = "@perry-starter/data/documents.cloud";

// Top-level regex literals (not constructed in loops) per the perf rule.
const CONCRETE_IMPL_IMPORT =
  /from\s+["'][^"']*(?:documents|assistant)\.(?:local|cloud)["']/;
const RUNTIME_TARGET_BRANCH = /\bif\s*\([^)]*PERRY_TARGET/;
const TS_SOURCE = /\.tsx?$/;

interface SeamImpl {
  __IMPL__: "local" | "cloud";
  documentsData: Record<string, unknown>;
}

interface ExportsMap {
  exports: Record<string, Record<string, string>>;
}

const readJson = (relPath: string): ExportsMap =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), "utf8"));

const collectSource = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSource(full, out);
    } else if (TS_SOURCE.test(entry.name)) {
      out.push(full);
    }
  }
};

test("per-target conditional exports map perry-local to *.local.ts and perry-cloud to *.cloud.ts as physically distinct modules (data + ai)", () => {
  for (const pkg of [
    { json: "packages/data/package.json", base: "documents" },
    { json: "packages/ai/package.json", base: "assistant" },
  ]) {
    const dotEntry = readJson(pkg.json).exports["."];
    // The "." entry resolves a DIFFERENT file under each target condition;
    // pointing perry-cloud at the *.local.ts file turns this red because the two
    // targets would resolve the same module.
    expect(dotEntry["perry-local"].endsWith(`${pkg.base}.local.ts`)).toBe(true);
    expect(dotEntry["perry-cloud"].endsWith(`${pkg.base}.cloud.ts`)).toBe(true);
    expect(dotEntry["perry-local"]).not.toBe(dotEntry["perry-cloud"]);
  }
});

test("each impl carries the matching resolution sentinel and the unselected impl is a distinct module", async () => {
  const local: SeamImpl = await import(DATA_LOCAL_MODULE);
  const cloud: SeamImpl = await import(DATA_CLOUD_MODULE);

  // The sentinel tells the test which impl resolved.
  expect(local.__IMPL__).toBe("local");
  expect(cloud.__IMPL__).toBe("cloud");
  // The unselected impl is not the resolved one — distinct module objects.
  expect(local.__IMPL__).not.toBe(cloud.__IMPL__);
  expect(local.documentsData).not.toBe(cloud.documentsData);
});

test("apps/web source imports only the @perry-starter/data seam, never a concrete *.local.ts/*.cloud.ts, and has no runtime target branch", () => {
  const files: string[] = [];
  collectSource(resolve(REPO_ROOT, "apps", "web", "src"), files);

  const concreteImporters: string[] = [];
  const runtimeBranchers: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (CONCRETE_IMPL_IMPORT.test(text)) {
      concreteImporters.push(file);
    }
    if (RUNTIME_TARGET_BRANCH.test(text)) {
      runtimeBranchers.push(file);
    }
  }

  // A single concrete-impl import or a runtime `if (PERRY_TARGET…)` data/AI
  // branch makes one of these arrays non-empty and turns the test red.
  expect(concreteImporters).toEqual([]);
  expect(runtimeBranchers).toEqual([]);
});
