// Mutation twin for the crypto-shred independence gate — proves the structural
// independence checker is load-bearing.
//
// It feeds the SAME checker (duplicated verbatim — test files must not import one
// another) sources that VIOLATE key-class independence (a shred key derived from the
// better-auth secret, from the token-at-rest envelope key, or via a shared-master
// KDF) and asserts each goes RED, with the real independent-draw source as the green
// control. If the checker passed any of these, the gate's independence assertion
// would be vacuous.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHRED_MODULE = resolve(HERE, "..", "crypto-shred-registry.ts");

// --- The structural independence checker (duplicated verbatim from the gate) ------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const OWN_CSPRNG_RE = /crypto\.getRandomValues\b/;

const CROSS_CLASS_RES: readonly [RegExp, string][] = [
  [/BETTER_AUTH_SECRET/, "reused-better-auth-secret"],
  [
    /generateEnvelopePassphrase|envelopePassphrase/i,
    "reused-token-at-rest-key",
  ],
  [/token-at-rest/i, "imports-token-at-rest-module"],
  [/\bPBKDF2\b|\bHKDF\b|deriveKey|deriveBits/i, "derives-from-shared-master"],
];

const crossClassDerivationHits = (source: string): string[] => {
  const code = stripJsComments(source);
  const hits: string[] = [];
  for (const [re, label] of CROSS_CLASS_RES) {
    if (re.test(code)) {
      hits.push(label);
    }
  }
  return hits;
};

const drawsOwnCsprng = (source: string): boolean =>
  OWN_CSPRNG_RE.test(stripJsComments(source));

test("a shred key derived from the better-auth secret reddens the independence checker", () => {
  const bad =
    "const key = derive(env.BETTER_AUTH_SECRET, subject); export const generateShredKey = () => key;";
  expect(crossClassDerivationHits(bad)).toContain("reused-better-auth-secret");
});

test("a shred key derived from the token-at-rest envelope key reddens the checker", () => {
  const bad =
    "import { generateEnvelopePassphrase } from '../../apps/daemon/src/token-at-rest';\nexport const generateShredKey = () => generateEnvelopePassphrase();";
  const hits = crossClassDerivationHits(bad);
  expect(hits).toContain("reused-token-at-rest-key");
  expect(hits).toContain("imports-token-at-rest-module");
});

test("a shred key stretched from a shared master via a KDF reddens the checker", () => {
  const bad =
    "export const generateShredKey = (m) => crypto.subtle.deriveKey({ name: 'PBKDF2' }, m);";
  expect(crossClassDerivationHits(bad)).toContain("derives-from-shared-master");
});

test("a shred key that does NOT draw its own CSPRNG reddens the own-entropy check", () => {
  const bad = "export const generateShredKey = () => someInjectedMaster;";
  expect(drawsOwnCsprng(bad)).toBe(false);
});

test("green control: the real shred module is independent (own CSPRNG, zero cross-class hits)", () => {
  const source = readFileSync(SHRED_MODULE, "utf8");
  expect(drawsOwnCsprng(source)).toBe(true);
  expect(crossClassDerivationHits(source)).toEqual([]);
});
