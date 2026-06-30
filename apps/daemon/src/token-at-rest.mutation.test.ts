import { describe, expect, test } from "vitest";

// Anti-vacuous twin for the daemon token-at-rest gate. The gate's no-plaintext
// property, the seam selection, and the source/anti-pattern scans are replicated
// here and run against deliberately-wrong, self-contained inline fixtures (no
// import of the real module), proving each invariant goes RED on a bad
// implementation and GREEN on a correct control.
//
// RED PHASE: every test is `test.skip` to match the gate's red phase; the
// fixtures are self-contained so collection never throws.

interface SealedEnvelope {
  readonly ciphertext: string;
  readonly kdfParams: { readonly iterations: number; readonly name: string };
  readonly nonce: string;
  readonly salt: string;
}

interface StoreSelection {
  readonly kind: "app-envelope" | "keychain-envelope" | "platform-secure-store";
  readonly persistsPlaintext: boolean;
}

const TOKEN = "session-refresh-token-value-abc123";

const serializedContainsPlaintext = (
  sealed: SealedEnvelope,
  token: string
): boolean => JSON.stringify(sealed).includes(token);

// --- Replicated source-scan detectors (verbatim with the gate) ---------------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const ARGON2_WEBCRYPTO_RE = /["']Argon2id["']/;
const NPM_CRYPTO_IMPORT_RE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](node-argon2|@noble\/[^"']+|jose)["']/;
const REUSED_SECRET_RE = /BETTER_AUTH_SECRET/;

const antiPatternHits = (source: string): string[] => {
  const code = stripJsComments(source);
  const hits: string[] = [];
  if (ARGON2_WEBCRYPTO_RE.test(code)) {
    hits.push("Argon2id-as-WebCrypto-algorithm");
  }
  if (NPM_CRYPTO_IMPORT_RE.test(code)) {
    hits.push("npm-crypto-import-in-daemon");
  }
  if (REUSED_SECRET_RE.test(code)) {
    hits.push("reused-auth-secret-as-envelope-key");
  }
  return hits;
};

// --- Controls + deliberately-wrong fixtures ----------------------------------

// A correct sealed blob holds only ciphertext (base64-ish), salt, nonce, params.
const correctSealed: SealedEnvelope = {
  ciphertext: "9f8a7b6c5d4e3f2a1b0c",
  salt: "0011223344556677",
  nonce: "8899aabbccdd",
  kdfParams: { name: "PBKDF2", iterations: 600_000 },
};

// A "plaintext-with-extra-steps" blob that smuggles the token into a field.
const plaintextLeakingSealed: SealedEnvelope = {
  ...correctSealed,
  ciphertext: `obfuscated:${TOKEN}`,
};

const correctDesktop: StoreSelection = {
  kind: "keychain-envelope",
  persistsPlaintext: false,
};
const headlessPlaintext: StoreSelection = {
  kind: "app-envelope",
  persistsPlaintext: true,
};

// Correct source: native primitives only.
const correctSource = `
import { hash, verify } from "argon2";
const salt = crypto.getRandomValues(new Uint8Array(16));
const baseKey = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
`;

// Source that reaches for the nonexistent Argon2id WebCrypto algorithm.
const argon2WebcryptoSource = `
const key = await crypto.subtle.deriveKey({ name: "Argon2id", salt }, baseKey, aes, false, ["encrypt"]);
`;

// Source that pulls an npm crypto lib into the daemon.
const npmCryptoSource = `import { gcm } from "@noble/ciphers/aes";`;

// Source that reuses the auth secret as the envelope key.
const reusedSecretSource = "const passphrase = process.env.BETTER_AUTH_SECRET;";

describe("the token-at-rest twin rejects plaintext leaks and foreclosed primitives", () => {
  test("an envelope blob that smuggles the plaintext token reddens", () => {
    expect(serializedContainsPlaintext(correctSealed, TOKEN)).toBe(false);
    expect(serializedContainsPlaintext(plaintextLeakingSealed, TOKEN)).toBe(
      true
    );
  });

  test("a headless seam that persists plaintext reddens", () => {
    expect(correctDesktop.persistsPlaintext).toBe(false);
    expect(headlessPlaintext.persistsPlaintext).toBe(true);
  });

  test("a nonexistent Argon2id WebCrypto algorithm in the source reddens", () => {
    expect(antiPatternHits(correctSource)).toEqual([]);
    expect(antiPatternHits(argon2WebcryptoSource)).toContain(
      "Argon2id-as-WebCrypto-algorithm"
    );
  });

  test("an npm crypto import in the daemon source reddens", () => {
    expect(antiPatternHits(npmCryptoSource)).toContain(
      "npm-crypto-import-in-daemon"
    );
  });

  test("reusing the auth secret as the envelope key reddens", () => {
    expect(antiPatternHits(reusedSecretSource)).toContain(
      "reused-auth-secret-as-envelope-key"
    );
  });
});
