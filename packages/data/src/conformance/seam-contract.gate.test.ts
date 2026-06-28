import { expect, test } from "vitest";

// Conformance gate — the uniform data seam contract.
//
// The data seam presents an IDENTICAL method surface whether backed by the
// local sidecar or the cloud relay; application/UI/auth code never forks on the
// build target because both impls key on the same methods. Impl modules are
// imported via variable specifiers inside the test bodies so this file collects
// cleanly.
//
// The mutation twin (seam-contract.mutation.test.ts) proves the key-set
// comparison this gate trusts genuinely flags a divergent target.

type KeyedImpl = Record<string, unknown>;

const DATA_LOCAL_MODULE = "@perry-starter/data/documents.local";
const DATA_CLOUD_MODULE = "@perry-starter/data/documents.cloud";
const SEAM_MEMBER = "documentsData";

const importImpl = async (specifier: string): Promise<KeyedImpl> => {
  const mod: Record<string, KeyedImpl> = await import(specifier);
  return mod;
};

const methodKeys = (mod: KeyedImpl): string[] =>
  Object.keys(mod[SEAM_MEMBER] as KeyedImpl).sort();

const sameKeySet = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

test("the data seam exposes a non-empty method surface for both targets", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const cloud = await importImpl(DATA_CLOUD_MODULE);

  // A non-empty surface is required — parity over an empty stub would pass
  // trivially.
  expect(methodKeys(local).length).toBeGreaterThan(0);
  expect(methodKeys(cloud).length).toBeGreaterThan(0);
});

test("the local and cloud data impls expose an identical method key-set", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const cloud = await importImpl(DATA_CLOUD_MODULE);

  // Adding or removing a method on either impl diverges the key-set and reddens.
  expect(sameKeySet(methodKeys(local), methodKeys(cloud))).toBe(true);
});
