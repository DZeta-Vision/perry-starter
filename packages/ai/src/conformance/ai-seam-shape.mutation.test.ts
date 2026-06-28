import { expect, test } from "vitest";

// Mutation twin for ai-seam-shape.gate.test.ts — the anti-vacuous proof.
//
// The same comparisons the gate trusts MUST flag a divergent target surface AND
// a non-callable member. We derive a realistic key-set from the live local
// impl, then compare against mutated copies, and we run the callable check over
// a surface whose member is a data value rather than a function. If either
// check stopped discriminating, the matching assertion turns the twin red.

type KeyedImpl = Record<string, unknown>;

const AI_LOCAL_MODULE = "@perry-starter/ai/assistant.local";
const SEAM_MEMBER = "assistant";

const importImpl = async (specifier: string): Promise<KeyedImpl> => {
  const mod: Record<string, KeyedImpl> = await import(specifier);
  return mod;
};

const seamKeys = (mod: KeyedImpl): string[] =>
  Object.keys(mod[SEAM_MEMBER] as KeyedImpl).sort();

const sameKeySet = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

const isCallableSurface = (surface: KeyedImpl): boolean =>
  Object.values(surface).every((member) => typeof member === "function");

test("a target that DROPPED an AI method diverges from the real key-set", async () => {
  const local = await importImpl(AI_LOCAL_MODULE);
  const real = seamKeys(local);

  expect(real.length).toBeGreaterThan(0);
  const dropped = real.slice(1);
  expect(sameKeySet(real, dropped)).toBe(false);
});

test("a target that RENAMED an AI method diverges even at the same method count", async () => {
  const local = await importImpl(AI_LOCAL_MODULE);
  const real = seamKeys(local);

  const renamed = ["__renamed__", ...real.slice(1)].sort();
  expect(renamed.length).toBe(real.length);
  expect(sameKeySet(real, renamed)).toBe(false);
});

test("a non-function member fails the callable-surface check while an all-function surface passes", () => {
  // A method stubbed out as a data value (not a function) must be rejected —
  // the seam is callable-shape-only.
  const brokenSurface: KeyedImpl = {
    complete: () => undefined,
    summarize: 42,
  };
  expect(isCallableSurface(brokenSurface)).toBe(false);

  const cleanSurface: KeyedImpl = {
    complete: () => undefined,
    summarize: () => undefined,
  };
  expect(isCallableSurface(cleanSurface)).toBe(true);
});
