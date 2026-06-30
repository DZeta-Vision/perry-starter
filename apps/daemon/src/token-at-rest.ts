// The daemon token-at-rest envelope + the PERRY_TARGET secure-store seam.
//
// The no-plaintext floor: an auth token persisted on the desktop client
// is NEVER written as plaintext (nor "plaintext-with-extra-steps"). The desktop
// primary is the OS Keychain (perry/system); where no secure store exists
// (headless Linux — [UNVALIDATED — S5], the perry-ui-gtk4 keychain backend has
// no headless context) the ONLY acceptable fallback is this app-level envelope.
// Mobile/web (Cloud-Relay) persist via platform secure storage / HttpOnly
// cookies — selected at build time by PERRY_TARGET, never a runtime branch into
// a plaintext store.
//
// Real key custody (its own key class): the AES-256-GCM key is DERIVED from a
// passphrase via crypto.subtle PBKDF2 over a per-token random salt, so the key
// is re-derivable on open (custody is the passphrase + the persisted salt) — not
// an ephemeral, discarded key. Argon2id is NOT a crypto.subtle algorithm at the
// pin: it is the native `argon2` module, used here for PASSPHRASE VERIFICATION
// (the operator leg), while the AES key BYTES come from crypto.subtle PBKDF2.
//
// Perry integration law: every primitive is native Perry stdlib reachable under
// `perry compile` — crypto.subtle (AES-GCM / PBKDF2 deriveKey / importKey),
// crypto.getRandomValues, the native argon2 module — and NO npm/WASM/prebuilt-JS
// crypto lib enters the daemon. The envelope key material is generated
// independently and never reuses any other key class.

// Derivation cost for the AES key bytes (crypto.subtle PBKDF2, SHA-256).
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const AES_KEY_BITS = 256;

const SALT_BYTES = 16;
const GCM_NONCE_BYTES = 12; // 96-bit IV for AES-GCM
const ENVELOPE_PASSPHRASE_BYTES = 32; // 256-bit independently-generated master

export type PerryTarget = "cloud-relay" | "local-sidecar";

export interface KdfParams {
  readonly hash: string;
  readonly iterations: number;
  readonly name: string;
}

// The persisted artifact — ONLY ciphertext + the public derivation inputs. Never
// the key, never the passphrase, never the plaintext token.
export interface SealedEnvelope {
  readonly ciphertext: string;
  readonly kdfParams: KdfParams;
  readonly nonce: string;
  readonly salt: string;
}

export interface StoreSelection {
  readonly kind: "app-envelope" | "keychain-envelope" | "platform-secure-store";
  readonly persistsPlaintext: false;
}

// --- base64 helpers (Web `btoa`/`atob`, no Node Buffer — stays compile-safe) --

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

// Derive the 256-bit AES-GCM key from the passphrase + salt via crypto.subtle
// PBKDF2 (NOT argon2 — Argon2id is not a crypto.subtle algorithm). The key is
// non-extractable: it never leaves the runtime.
const deriveAesKey = async (
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> => {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"]
  );
};

// Seal a token into the AES-256-GCM envelope. The salt + nonce are freshly
// random per token; the persisted blob carries only {ciphertext, salt, nonce,
// kdfParams} — never the key or the plaintext.
export const sealToken = async (
  token: string,
  passphrase: string
): Promise<SealedEnvelope> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const aesKey = await deriveAesKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    new TextEncoder().encode(token)
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    kdfParams: {
      name: "PBKDF2",
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    nonce: bytesToBase64(nonce),
    salt: bytesToBase64(salt),
  };
};

// Open a sealed envelope: re-derive the AES key from the passphrase + the stored
// salt, then AES-256-GCM-decrypt. A wrong passphrase / tampered ciphertext fails
// the GCM auth tag and rejects.
export const openToken = async (
  sealed: SealedEnvelope,
  passphrase: string
): Promise<string> => {
  const salt = base64ToBytes(sealed.salt);
  const nonce = base64ToBytes(sealed.nonce);
  const aesKey = await deriveAesKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    base64ToBytes(sealed.ciphertext)
  );
  return new TextDecoder().decode(plaintext);
};

// The PERRY_TARGET secure-store seam. Desktop selects the OS Keychain WITH the
// envelope when a secure store exists, else the app-level envelope floor;
// mobile/web select platform secure storage / HttpOnly cookies. No target ever
// resolves to a plaintext store.
export const secureStoreForTarget = (
  target: PerryTarget,
  hasSecureStore: boolean
): StoreSelection => {
  if (target === "cloud-relay") {
    return { kind: "platform-secure-store", persistsPlaintext: false };
  }
  if (hasSecureStore) {
    return { kind: "keychain-envelope", persistsPlaintext: false };
  }
  // Headless Linux [UNVALIDATED — S5]: no proven keychain backend, so the
  // app-level envelope is the no-plaintext floor.
  return { kind: "app-envelope", persistsPlaintext: false };
};

// Generate the envelope passphrase/master INDEPENDENTLY (its own key class) — from
// the runtime CSPRNG, never derived from the better-auth secret or any other key
// class.
export const generateEnvelopePassphrase = (): string =>
  bytesToBase64(
    crypto.getRandomValues(new Uint8Array(ENVELOPE_PASSPHRASE_BYTES))
  );

// The native Perry `argon2` module — the password-stretching KDF for passphrase
// VERIFICATION (Argon2id at the FFI layer). Referenced lazily (never a top-level
// import) so the AES-GCM envelope core round-trips under node vitest without the
// native module present; the hash/verify legs run only under a perry compile +
// runtime assert (the operator leg). Do not slice the PHC string for key
// material — the AES key bytes come from crypto.subtle PBKDF2 above.
const ARGON2_MODULE_SPECIFIER = "argon2";

interface Argon2Module {
  readonly hash: (password: string) => Promise<string>;
  readonly verify: (storedHash: string, password: string) => Promise<boolean>;
}

const loadArgon2 = async (): Promise<Argon2Module> =>
  (await import(
    /* @vite-ignore */ ARGON2_MODULE_SPECIFIER
  )) as unknown as Argon2Module;

// Store a PHC verification string for the envelope passphrase (operator leg).
export const hashPassphrase = async (passphrase: string): Promise<string> => {
  const argon2 = await loadArgon2();
  return argon2.hash(passphrase);
};

// Verify a supplied passphrase against the stored PHC string before opening the
// envelope. NOTE the argument order: (storedHash, passphrase) (operator leg).
export const verifyPassphrase = async (
  storedHash: string,
  passphrase: string
): Promise<boolean> => {
  const argon2 = await loadArgon2();
  return argon2.verify(storedHash, passphrase);
};
