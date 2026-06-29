// NON-PRODUCTION ES256 JWT fixtures for the DB-layer fail-closed verification
// tests. The public half of THIS fixed keypair is pinned into the
// `DEFINE ACCESS … TYPE JWT ALGORITHM ES256 KEY …` clause in the database
// schema, so a token minted here with the private half verifies at the data
// layer, while a tampered / expired / wrong-algorithm token is rejected
// (fail closed).
//
// This is TEST-ONLY material — the private key is committed deliberately because
// it grants nothing beyond the disposable in-memory test sidecar. It is never the
// production signing key (that is the cloud authority's rotating ES256 JWKS).

// The fixed non-prod P-256 private key matching the SPKI public key in the schema.
const TEST_PRIVATE_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "fjrw6CpYRRgSsB9myFHWEG5hsGBl_UeQHpuVS6j17lo",
  y: "DALTIl82q5qf8yrqcjwhyMYmsYmWklz6IU7jgcuoojc",
  d: "BJASD4Cyjgt5ZC2OzGGojOunci_r1CSiTYFJQnDGBCY",
};

// The DB-layer JWT access this token authenticates against, and the namespace /
// database it is scoped to (matching the test sidecar + the schema access name).
const ACCESS = "api";
const NS = "perry";
const DB = "perry";

const SECONDS_PER_HOUR = 3600;

const TRAILING_PAD_RE = /=+$/;
const PLUS_RE = /\+/g;
const SLASH_RE = /\//g;

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(TRAILING_PAD_RE, "")
    .replace(PLUS_RE, "-")
    .replace(SLASH_RE, "_");
};

const b64urlFromString = (value: string): string =>
  b64urlFromBytes(new TextEncoder().encode(value));

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface MintOptions {
  readonly alg?: string;
  readonly exp?: number;
  readonly tamper?: boolean;
}

const signingInputFor = (alg: string, exp: number): string => {
  const header = { alg, typ: "JWT" };
  const issued = nowSeconds();
  const payload = { ns: NS, db: DB, ac: ACCESS, iat: issued, exp };
  return `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
};

const signEs256 = async (signingInput: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return b64urlFromBytes(new Uint8Array(signature));
};

const mint = async (opts: MintOptions = {}): Promise<string> => {
  const alg = opts.alg ?? "ES256";
  const exp = opts.exp ?? nowSeconds() + SECONDS_PER_HOUR;
  const signingInput = signingInputFor(alg, exp);
  // A "none"-algorithm token carries no signature — the ALGORITHM ES256 access
  // rejects it outright (the wrong-algorithm fail-closed case).
  if (alg !== "ES256") {
    return `${signingInput}.`;
  }
  let signature = await signEs256(signingInput);
  if (opts.tamper) {
    signature =
      signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
  }
  return `${signingInput}.${signature}`;
};

// A correctly-signed, unexpired ES256 token the data layer accepts.
export const mintValidEs256 = (): Promise<string> => mint();

// A correctly-shaped ES256 token whose signature is corrupted — rejected.
export const mintTamperedEs256 = (): Promise<string> => mint({ tamper: true });

// A correctly-signed ES256 token whose `exp` is in the past — rejected.
export const mintExpiredEs256 = (): Promise<string> =>
  mint({ exp: nowSeconds() - SECONDS_PER_HOUR });

// A token whose header advertises a non-ES256 algorithm — rejected by the
// ALGORITHM ES256 access independent of any signature.
export const mintWrongAlg = (): Promise<string> => mint({ alg: "none" });
