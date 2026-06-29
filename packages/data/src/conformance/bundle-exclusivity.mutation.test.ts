// Mutation twin for the exclusivity gate. Each detector is replicated as a pure
// scan and fed a known-bad input; the twin asserts the detector FLAGS the bad
// input (so the gate would redden), with a clean control proving it is not
// always-firing:
//   (1) a "both-impls" bundle (a runtime if / wrong condition bundling both seam
//       impls) → the unselected sentinel is detected present.
//   (2) a vite config with `ssr.resolve.conditions` stripped → the server-leg
//       condition is detected absent.

import { describe, expect, test } from "vitest";

// Same detectors the gate uses (kept in sync at green phase).
const LOCAL_SENTINEL_RE =
  /__IMPL__[^\n]{0,32}["']local["']|["']perry-impl:local["']/;
const CLOUD_SENTINEL_RE =
  /__IMPL__[^\n]{0,32}["']cloud["']|["']perry-impl:cloud["']/;
const SSR_CONDITIONS_RE =
  /ssr\s*:\s*\{[\s\S]*?resolve\s*:\s*\{[\s\S]*?conditions/;

// A correctly-resolved local graph carries only the local sentinel.
const CLEAN_LOCAL_GRAPH = 'const __IMPL__ = "local"; export { __IMPL__ };';
// A both-impls leak: a runtime branch dragged BOTH seam impls into the graph.
const LEAKY_LOCAL_GRAPH =
  'const a = "perry-impl:local"; const b = "perry-impl:cloud";';

// A config carrying both client + server resolution conditions.
const CLEAN_CONFIG =
  "resolve: { conditions: [c] }, ssr: { resolve: { conditions: [c] } }";
// The d5 regression: ssr.resolve.conditions removed.
const STRIPPED_CONFIG = "resolve: { conditions: [c] }, ssr: { noExternal: [] }";

describe("the exclusivity detector flags a leaked impl in the consumed graph", () => {
  test("a both-impls bundle is detected as carrying the unselected (cloud) sentinel", () => {
    expect(CLOUD_SENTINEL_RE.test(LEAKY_LOCAL_GRAPH)).toBe(true);
  });

  test("a correctly-resolved local graph carries only the local sentinel (not always-firing)", () => {
    expect(LOCAL_SENTINEL_RE.test(CLEAN_LOCAL_GRAPH)).toBe(true);
    expect(CLOUD_SENTINEL_RE.test(CLEAN_LOCAL_GRAPH)).toBe(false);
  });
});

describe("the server-leg detector flags a config missing ssr.resolve.conditions", () => {
  test("a config with ssr.resolve.conditions stripped is detected as missing the server condition", () => {
    expect(SSR_CONDITIONS_RE.test(STRIPPED_CONFIG)).toBe(false);
  });

  test("a config carrying both client + server conditions stays green (not always-firing)", () => {
    expect(SSR_CONDITIONS_RE.test(CLEAN_CONFIG)).toBe(true);
  });
});
