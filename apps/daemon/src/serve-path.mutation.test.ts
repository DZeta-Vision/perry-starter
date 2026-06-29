// Mutation twin for the serve-path gate: it replicates the contract's request
// classification as a pure function and feeds it the WRONG order (catch-all →
// shell registered before the `/api/**` allow-list). Under the reversed order an
// `/api/*` request is wrongly classified as the shell — so the gate's "not
// rewritten" assertion would flip. The correct order is the green control.

import { describe, expect, test } from "vitest";

type Disposition = "asset" | "passthrough" | "shell";
type ContractStep = "allow-list" | "catch-all" | "static-assets";

const ASSET_RE = /^\/assets\//;
const ALLOW_LIST_RE = /^\/(?:api|_serverFn)\//;

// Classify a request by walking the contract steps IN THE GIVEN ORDER — the
// first matching step wins (mirrors fastify registration precedence).
const classify = (
  pathname: string,
  order: readonly ContractStep[]
): Disposition => {
  for (const step of order) {
    if (step === "static-assets" && ASSET_RE.test(pathname)) {
      return "asset";
    }
    if (step === "allow-list" && ALLOW_LIST_RE.test(pathname)) {
      return "passthrough";
    }
    if (step === "catch-all") {
      return "shell";
    }
  }
  return "shell";
};

const CORRECT_ORDER: readonly ContractStep[] = [
  "static-assets",
  "allow-list",
  "catch-all",
];
// Mutant: the catch-all is registered before the allow-list.
const REVERSED_ORDER: readonly ContractStep[] = [
  "static-assets",
  "catch-all",
  "allow-list",
];

describe("the reversed contract order wrongly rewrites the local API to the shell", () => {
  test("under the reversed order an `/api/*` request is classified as the shell (the gate would flip)", () => {
    expect(classify("/api/ping", REVERSED_ORDER)).toBe("shell");
  });

  test("under the correct order an `/api/*` request passes through (not always-firing)", () => {
    expect(classify("/api/ping", CORRECT_ORDER)).toBe("passthrough");
    expect(classify("/documents/deep/link", CORRECT_ORDER)).toBe("shell");
    expect(classify("/assets/app.js", CORRECT_ORDER)).toBe("asset");
  });
});
