import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The data seam and AI seam present an IDENTICAL contract whether backed local
// or cloud (uniform data+AI seam); the AI seam is shape-only here (concrete
// impls land later) yet compiles for both targets; and the seam packages depend
// on the contracts tier only — never the reverse (the seam never imports the
// consuming auth tier).
//
// Impl modules are imported via variable specifiers inside the test bodies, and
// package.json reads use node:fs inside the test bodies, so this file collects
// cleanly.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const SEAM_PACKAGE_NAMES = ["@perry-starter/data", "@perry-starter/ai"];

type KeyedImpl = Record<string, unknown>;

const importImpl = async (specifier: string): Promise<KeyedImpl> => {
  const mod: Record<string, KeyedImpl> = await import(specifier);
  return mod;
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
}

const readPackageJson = (relDir: string): PackageJson | null => {
  try {
    return JSON.parse(
      readFileSync(resolve(REPO_ROOT, relDir, "package.json"), "utf8")
    );
  } catch {
    return null; // an upstream tier (e.g. packages/db) may not exist yet.
  }
};

const dependencyNames = (pkg: PackageJson): string[] => [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];

test("data + AI seam local/cloud impls expose identical method key-sets — the contract is uniform across both targets", async () => {
  const dataLocal = await importImpl("@perry-starter/data/documents.local");
  const dataCloud = await importImpl("@perry-starter/data/documents.cloud");
  const aiLocal = await importImpl("@perry-starter/ai/assistant.local");
  const aiCloud = await importImpl("@perry-starter/ai/assistant.cloud");

  const keys = (impl: KeyedImpl, member: string): string[] =>
    Object.keys(impl[member] as KeyedImpl).sort();

  // Adding/removing a method on ONE impl diverges the key-sets and turns this
  // red.
  expect(keys(dataLocal, "documentsData")).toEqual(
    keys(dataCloud, "documentsData")
  );
  expect(keys(aiLocal, "assistant")).toEqual(keys(aiCloud, "assistant"));
});

test("the AI seam is shape-only and present for both targets — a non-empty, identical method surface that compiles local and cloud", async () => {
  const aiLocal = await importImpl("@perry-starter/ai/assistant.local");
  const aiCloud = await importImpl("@perry-starter/ai/assistant.cloud");

  const localKeys = Object.keys(aiLocal.assistant as KeyedImpl);
  const cloudKeys = Object.keys(aiCloud.assistant as KeyedImpl);

  // Shape-only is not empty: the seam must expose at least one method for both
  // targets (otherwise parity would pass trivially over an empty stub).
  expect(localKeys.length).toBeGreaterThan(0);
  expect(localKeys.sort()).toEqual(cloudKeys.sort());
  // Every method is a callable shape (impls may throw notImplemented for now).
  for (const key of localKeys) {
    expect(typeof (aiLocal.assistant as KeyedImpl)[key]).toBe("function");
  }
});

test("packages/api, packages/auth, and packages/db declare NO dependency on @perry-starter/data or @perry-starter/ai (the reverse edge is absent)", () => {
  for (const tier of ["packages/api", "packages/auth", "packages/db"]) {
    const pkg = readPackageJson(tier);
    if (pkg === null) {
      continue;
    }
    const deps = dependencyNames(pkg);
    // The contract/auth/db tiers must never depend on the seam packages.
    // Injecting a synthetic @perry-starter/data dep into any of these makes the
    // intersection non-empty and turns this red.
    for (const seam of SEAM_PACKAGE_NAMES) {
      expect(deps).not.toContain(seam);
    }
  }

  // Forward edge sanity: the seam packages may depend on the contracts tier or
  // below, but not on the consuming tiers — assert they do not depend on
  // @perry-starter/auth.
  for (const seamDir of ["packages/data", "packages/ai"]) {
    const pkg = readPackageJson(seamDir);
    if (pkg === null) {
      continue;
    }
    expect(dependencyNames(pkg)).not.toContain("@perry-starter/auth");
  }
});
