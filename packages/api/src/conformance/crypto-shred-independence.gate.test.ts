// Fourth-key-class independence gate — the per-subject crypto-shred key is a
// DISTINCT key class, never derived from or sharing material with the token-at-rest
// envelope key (class 3) or any other class.
//
// The independence is proven three ways over the REAL crypto-shred-registry source:
//   1. STRUCTURAL: the shred key is drawn from its OWN CSPRNG (`crypto.getRandomValues`)
//      and the module references NO other class's key/secret/derivation — no
//      BETTER_AUTH_SECRET, no envelope passphrase / token-at-rest reference, no
//      PBKDF2/HKDF/deriveKey derivation from a shared master, no import of the daemon
//      token-at-rest module. So there is no shared derivation input with class 3.
//   2. RUNTIME: two generated shred keys differ (independent draws — the key is not a
//      deterministic function of a fixed subject/master), and are full 256-bit
//      material.
//   3. CROSS-MODULE: the token-at-rest envelope key lives in a SEPARATE module
//      (apps/daemon), and the shred module names none of its key material — the two
//      classes never cross-use.
//
// The MECHANISM-DEFERRED honesty leg: the module exposes only the registry surface +
// the key generation (direction), and NO operation that performs the actual
// cryptographic destruction — `CRYPTO_SHRED_MECHANISM` is "deferred" and no test
// here claims real destruction.
//
// The mutation twin feeds the SAME structural checker a source that derives the
// shred key from the envelope key / better-auth secret and asserts it reddens.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  buildRegisterShredSubjectSql,
  CRYPTO_SHRED_MECHANISM,
  generateShredKey,
  isRegistrationOnlySql,
} from "../crypto-shred-registry";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/api/src/conformance
const SHRED_MODULE = resolve(HERE, "..", "crypto-shred-registry.ts");
const TOKEN_AT_REST_MODULE = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "daemon",
  "src",
  "token-at-rest.ts"
);

const read = (path: string): string => readFileSync(path, "utf8");

// --- The structural independence checker (replicated verbatim in the twin) -------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// Its OWN entropy source — an independent CSPRNG draw, not a derivation.
const OWN_CSPRNG_RE = /crypto\.getRandomValues\b/;
const TOKEN_AT_REST_REF_RE = /token-at-rest/i;
const SHRED_TABLE_DELETE_RE = /\bDELETE\s+erasure_shred_subject\b/i;
const SHRED_TABLE_REMOVE_RE =
  /\bREMOVE\s+(?:TABLE|FIELD)?\s*erasure_shred_subject\b/i;

// Markers that the shred key is derived from / shares material with another key
// class — each is a cross-class contamination the 4th class must never have.
const CROSS_CLASS_RES: readonly [RegExp, string][] = [
  [/BETTER_AUTH_SECRET/, "reused-better-auth-secret"],
  [
    /generateEnvelopePassphrase|envelopePassphrase/i,
    "reused-token-at-rest-key",
  ],
  [/token-at-rest/i, "imports-token-at-rest-module"],
  [/\bPBKDF2\b|\bHKDF\b|deriveKey|deriveBits/i, "derives-from-shared-master"],
];

// The shred module must draw its own CSPRNG and reference no other class's material.
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

test("the shred key is drawn from its own CSPRNG and shares no material or derivation with another key class", () => {
  const source = read(SHRED_MODULE);
  expect(drawsOwnCsprng(source)).toBe(true);
  expect(crossClassDerivationHits(source)).toEqual([]);
});

test("two generated shred keys are independent (not a deterministic function of a fixed master) and full 256-bit material", () => {
  const a = generateShredKey();
  const b = generateShredKey();
  expect(a).not.toBe(b);
  // 32 raw bytes base64-encoded → 44 chars (with padding).
  expect(a).toHaveLength(44);
  expect(b).toHaveLength(44);
});

test("the token-at-rest envelope key is a SEPARATE module and the shred module names none of its key material (never cross-used)", () => {
  // The class-3 envelope key generator lives in the daemon token-at-rest module...
  expect(read(TOKEN_AT_REST_MODULE)).toContain("generateEnvelopePassphrase");
  // ...and the shred module references neither it nor the token-at-rest module.
  const shred = stripJsComments(read(SHRED_MODULE));
  expect(shred).not.toContain("generateEnvelopePassphrase");
  expect(shred).not.toMatch(TOKEN_AT_REST_REF_RE);
});

test("the crypto-shred MECHANISM is deferred — the module ships the registry surface, not actual destruction", () => {
  // The mechanism is explicitly deferred (design-only)...
  expect(CRYPTO_SHRED_MECHANISM).toBe("deferred");
  // ...and the only registry statement the module emits is additive registration —
  // there is NO operation that deletes/overwrites key material (no destruction claim).
  expect(
    isRegistrationOnlySql(
      buildRegisterShredSubjectSql("user-1", "key-handle-abc").query
    )
  ).toBe(true);
  const shred = stripJsComments(read(SHRED_MODULE));
  // No destructive registry op anywhere in the module (the shred itself is deferred).
  expect(shred).not.toMatch(SHRED_TABLE_DELETE_RE);
  expect(shred).not.toMatch(SHRED_TABLE_REMOVE_RE);
});
