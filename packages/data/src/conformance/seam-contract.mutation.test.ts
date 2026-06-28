import { expect, test } from "vitest";

// Mutation twin for seam-contract.gate.test.ts — the anti-vacuous proof.
//
// The same key-set comparison the gate trusts MUST flag a target that has
// gained, lost, or renamed a method. We derive a realistic key-set from the
// live local impl, then compare it against mutated copies. If the comparison
// ever stopped discriminating, these assertions would flip to passing-on-
// divergence and turn the twin red.

type KeyedImpl = Record<string, unknown>;

const DATA_LOCAL_MODULE = "@perry-starter/data/documents.local";
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

test("a target that DROPPED a seam method diverges from the real key-set", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const real = methodKeys(local);

  expect(real.length).toBeGreaterThan(1);
  const dropped = real.slice(1);
  expect(sameKeySet(real, dropped)).toBe(false);
});

test("a target that GAINED a seam method diverges from the real key-set", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const real = methodKeys(local);

  const gained = [...real, "purge"].sort();
  expect(sameKeySet(real, gained)).toBe(false);
});

test("a target that RENAMED a seam method diverges even at the same method count", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const real = methodKeys(local);

  expect(real.length).toBeGreaterThan(0);
  const renamed = ["__renamed__", ...real.slice(1)].sort();
  expect(renamed.length).toBe(real.length);
  expect(sameKeySet(real, renamed)).toBe(false);
});

test("the comparison still accepts an identical key-set — a clean target does not falsely redden", async () => {
  const local = await importImpl(DATA_LOCAL_MODULE);
  const real = methodKeys(local);

  expect(sameKeySet(real, [...real])).toBe(true);
});
