// TOTP secret at rest — the encrypted envelope + a controllable enrol/verify seam.
//
// Cloud/worker tier. The real TOTP lib integration (RFC-6238 code derivation) is
// spike-gated / design-only, so the enrol/challenge behavior is driven through a
// controllable seam with deterministic codes; what is asserted concretely here is
// the security-load-bearing property: the TOTP secret is ENCRYPTED AT REST and
// never persisted in plaintext. The envelope is AES-256-GCM via `crypto.subtle`
// under an independently-held key (never derived from the auth `secret`).

// A fresh 160-bit TOTP shared secret (the RFC-4226/6238 recommended size). Sole
// entropy source is `crypto.getRandomValues`.
const TOTP_SECRET_BYTES = 20;
const GCM_IV_BYTES = 12;

export const generateTotpSecret = (): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES));

// An independently-generated AES-256-GCM key for the TOTP-secret envelope (key
// independence — never the auth `secret`, never another class's key).
export const generateTotpEnvelopeKey = async (): Promise<CryptoKey> =>
  (await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;

export interface TotpSecretEnvelope {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
}

// Seal the TOTP secret. The returned envelope carries only the IV + ciphertext —
// never the plaintext secret bytes.
export const encryptTotpSecret = async (
  secret: Uint8Array,
  key: CryptoKey
): Promise<TotpSecretEnvelope> => {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { iv, name: "AES-GCM" },
    key,
    secret
  );
  return { ciphertext: new Uint8Array(sealed), iv };
};

// Open a sealed TOTP secret. GCM authentication rejects a tampered envelope.
export const decryptTotpSecret = async (
  envelope: TotpSecretEnvelope,
  key: CryptoKey
): Promise<Uint8Array> => {
  const opened = await crypto.subtle.decrypt(
    { iv: envelope.iv, name: "AES-GCM" },
    key,
    envelope.ciphertext
  );
  return new Uint8Array(opened);
};

// The controllable TOTP verifier seam (the spike-gated code-derivation stands in
// for the real RFC-6238 lib). A verify is timing-agnostic at this layer: it only
// compares the presented code against the seam's expected code for the secret.
export interface TotpVerifier {
  readonly currentCodeFor: (secret: Uint8Array) => string;
}

export const verifyTotpCode = (
  secret: Uint8Array,
  presented: string,
  verifier: TotpVerifier
): boolean => presented === verifier.currentCodeFor(secret);
