import { expect, test } from "vitest";

// Conformance gate — the AI seam shape.
//
// The AI seam is shape-only for now (concrete impls land later), yet it must
// present a non-empty, IDENTICAL, fully-callable method surface for both the
// local and cloud targets so the seam compiles for every target with no
// application-logic fork. Impl modules are imported via variable specifiers
// inside the test bodies so this file collects cleanly.
//
// The mutation twin (ai-seam-shape.mutation.test.ts) proves the parity and
// callable-surface checks genuinely flag a divergent or non-callable surface.

type KeyedImpl = Record<string, unknown>;

const AI_LOCAL_MODULE = "@perry-starter/ai/assistant.local";
const AI_CLOUD_MODULE = "@perry-starter/ai/assistant.cloud";
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

test("the AI seam exposes a non-empty method surface for both targets", async () => {
  const local = await importImpl(AI_LOCAL_MODULE);
  const cloud = await importImpl(AI_CLOUD_MODULE);

  // Shape-only is not empty: parity over an empty stub would pass trivially.
  expect(seamKeys(local).length).toBeGreaterThan(0);
  expect(seamKeys(cloud).length).toBeGreaterThan(0);
});

test("the local and cloud AI impls expose an identical key-set of callable methods", async () => {
  const local = await importImpl(AI_LOCAL_MODULE);
  const cloud = await importImpl(AI_CLOUD_MODULE);

  const localKeys = seamKeys(local);
  // Adding or removing a method on either impl diverges the key-set and reddens.
  expect(sameKeySet(localKeys, seamKeys(cloud))).toBe(true);

  const localSeam = local[SEAM_MEMBER] as KeyedImpl;
  for (const key of localKeys) {
    expect(typeof localSeam[key]).toBe("function");
  }
});
