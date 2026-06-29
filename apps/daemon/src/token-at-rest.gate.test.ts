import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate for the daemon token-at-rest envelope and target seam.
//
// The CI-deterministic legs are (a) the AES-256-GCM envelope round-trip keyed
// by a crypto.subtle PBKDF2/HKDF-derived key (node-runnable WebCrypto) plus the
// no-plaintext-blob property, (b) the PERRY_TARGET secure-store seam selection,
// and (c) source/anti-pattern scans (no npm crypto dependency, no nonexistent
// Argon2id WebCrypto algorithm, the envelope key independently generated and
// never the auth secret or another key class).
//
// The OS Keychain round-trip on headless Linux and the native argon2-module
// passphrase verify are OPERATOR legs (a perry compile + runtime assert), not
// node vitest gates — they are not authored here.
//
// RED PHASE: every test is `test.skip`. The module
// `apps/daemon/src/token-at-rest.ts` does not exist yet. Imports of it are
// dynamic `await import(...)` inside the skipped body; the source scans read the
// file inside the skipped body. Top-level static imports are limited to
// `vitest` and `node:*`.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src
const MODULE_FILE = resolve(HERE, "token-at-rest.ts");

type Target = "local-sidecar" | "cloud-relay";

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

interface TokenAtRestModule {
  readonly openToken: (
    sealed: SealedEnvelope,
    passphrase: string
  ) => Promise<string>;
  readonly sealToken: (
    token: string,
    passphrase: string
  ) => Promise<SealedEnvelope>;
  readonly secureStoreForTarget: (
    target: Target,
    hasSecureStore: boolean
  ) => StoreSelection;
}

const TOKEN = "session-refresh-token-value-abc123";
const PASSPHRASE = "correct horse battery staple";

// `./token-at-rest` does not exist yet (this story's dev phase adds it). Pass
// the specifier as a variable + `@vite-ignore` so the bundler does not eagerly
// resolve it at collection time and `tsc` does not try to type the module; the
// import only runs at runtime (never, while the tests are skipped).
const TOKEN_AT_REST_SPEC = "./token-at-rest";

const loadModule = async (): Promise<TokenAtRestModule> =>
  (await import(
    /* @vite-ignore */ TOKEN_AT_REST_SPEC
  )) as unknown as TokenAtRestModule;

const readSource = (): string => readFileSync(MODULE_FILE, "utf8");

// The serialized envelope, as a single string, must never contain the plaintext
// token bytes.
const serializedContainsPlaintext = (
  sealed: SealedEnvelope,
  token: string
): boolean => JSON.stringify(sealed).includes(token);

// --- Source-scan detectors (replicated verbatim in the mutation twin) --------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// Argon2id is NOT a WebCrypto algorithm at the pin — using it as a
// crypto.subtle deriveKey/algorithm name is a defect.
const ARGON2_WEBCRYPTO_RE = /["']Argon2id["']/;

// npm crypto libraries must not enter the daemon (they die at perry compile).
const NPM_CRYPTO_IMPORT_RE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](node-argon2|@noble\/[^"']+|jose)["']/;

// The envelope key must never reuse the better-auth secret or another key class.
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

describe("the daemon token-at-rest envelope never persists plaintext on any target", () => {
  test("the envelope round-trips the token and the serialized blob never contains the plaintext token", async () => {
    const m = await loadModule();
    const sealed = await m.sealToken(TOKEN, PASSPHRASE);
    const opened = await m.openToken(sealed, PASSPHRASE);
    expect(opened).toBe(TOKEN);
    expect(serializedContainsPlaintext(sealed, TOKEN)).toBe(false);
  });

  test("the sealed envelope stores only ciphertext, salt, nonce, and KDF params — never the plaintext or the key", async () => {
    const m = await loadModule();
    const sealed = await m.sealToken(TOKEN, PASSPHRASE);
    expect(Object.keys(sealed).sort()).toEqual([
      "ciphertext",
      "kdfParams",
      "nonce",
      "salt",
    ]);
    expect(serializedContainsPlaintext(sealed, TOKEN)).toBe(false);
    expect(serializedContainsPlaintext(sealed, PASSPHRASE)).toBe(false);
  });

  test("the desktop target selects the keychain-with-envelope path and a headless target falls back to the app-level envelope — never plaintext", async () => {
    const m = await loadModule();
    const desktopWithStore = m.secureStoreForTarget("local-sidecar", true);
    expect(desktopWithStore.kind).toBe("keychain-envelope");
    expect(desktopWithStore.persistsPlaintext).toBe(false);
    const headless = m.secureStoreForTarget("local-sidecar", false);
    expect(headless.kind).toBe("app-envelope");
    expect(headless.persistsPlaintext).toBe(false);
  });

  test("mobile and web targets persist via platform secure storage, never a plaintext store", async () => {
    const m = await loadModule();
    const cloud = m.secureStoreForTarget("cloud-relay", true);
    expect(cloud.kind).toBe("platform-secure-store");
    expect(cloud.persistsPlaintext).toBe(false);
  });

  test("the envelope uses native primitives only — no npm crypto dependency, no nonexistent Argon2id WebCrypto algorithm, and no reuse of the auth secret as the key", () => {
    expect(antiPatternHits(readSource())).toEqual([]);
  });
});
