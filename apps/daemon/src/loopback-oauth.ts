import {
  createCipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { guardedFetch } from "./egress-allowlist";

// The desktop client's loopback OAuth callback (daemon tier). Plain TS over
// native APIs — node:crypto + fastify + native `fetch` (through guardedFetch) —
// so it survives `perry compile`: NO in-process auth SDK/WASM/prebuilt-JS.
//
// The control posture: the 127.0.0.1 loopback listener is the PRIMARY callback
// on EVERY desktop OS; loopback is NOT a security boundary, so the security
// rests on PKCE (S256), a high-entropy single-use `state`, and a single-use
// one-time code — never the bind address. A mismatched/replayed `state` or a
// reused code fails closed.
//
// The authority model: the daemon is an UNTRUSTED relay. It brokers the
// callback and relays the one-time code to the cloud authority over HTTPS, then
// RECEIVES a cloud-minted session token. It never mints a session or decides
// identity locally; the provider client secrets stay server-side.

const LOOPBACK_HOST = "127.0.0.1";

// The cloud gatekeeper Worker — the daemon's one-time-code exchange target,
// already on the egress allowlist. NOT a provider host.
const CLOUD_AUTHORITY_ORIGIN = "https://api.perryts.com";
const LOOPBACK_EXCHANGE_PATH = "/auth/oauth/loopback-exchange";

const STATE_ENTROPY_BYTES = 32; // 256-bit single-use state
const PKCE_VERIFIER_BYTES = 32;
const AES_KEY_BYTES = 32; // AES-256
const GCM_NONCE_BYTES = 12;

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

const SECURE_STORE_KEY = "perry.session-token";

// GitHub OAuth Apps register a SINGLE fixed callback URL and do NOT honor an
// arbitrary loopback port the way Google "Desktop app" clients do. Pin GitHub to
// a fixed registered loopback port; Google takes the requested ephemeral port.
// The concrete registered port is a deploy-time OAuth-app configuration.
const GITHUB_FIXED_LOOPBACK_PORT = 8765;

const AUTHORIZE_ENDPOINTS = {
  github: "https://github.com/login/oauth/authorize",
  google: "https://accounts.google.com/o/oauth2/v2/auth",
} as const;

export type OAuthProvider = keyof typeof AUTHORIZE_ENDPOINTS;

const CALLBACK_OK_HTML =
  "<!doctype html><title>Signed in</title><p>You may close this window.</p>";
const CALLBACK_REJECTED_HTML =
  "<!doctype html><title>Sign-in failed</title><p>This sign-in attempt could not be completed.</p>";

// PKCE S256: the code challenge is base64url(SHA-256(code_verifier)).
const pkceChallengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

// GitHub gets the fixed registered loopback port; every other provider gets the
// requested ephemeral port. Loopback stays the callback host either way.
const loopbackPortFor = (
  provider: OAuthProvider,
  requestedPort: number
): number =>
  provider === "github" ? GITHUB_FIXED_LOOPBACK_PORT : requestedPort;

export interface AuthorizeRequest {
  readonly codeChallenge: string;
  readonly codeVerifier: string;
  readonly port: number;
  readonly redirectUri: string;
  readonly state: string;
  readonly url: string;
}

// Build the provider authorize URL for the loopback flow: a PKCE S256 challenge,
// a fresh ≥256-bit `state`, and a 127.0.0.1 loopback `redirect_uri` — the PRIMARY
// callback on every desktop OS (no OS branch swaps the primary mechanism).
export const buildAuthorizeRequest = ({
  provider,
  port,
}: {
  provider: OAuthProvider;
  port: number;
}): AuthorizeRequest => {
  const codeVerifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
  const codeChallenge = pkceChallengeFor(codeVerifier);
  const state = randomBytes(STATE_ENTROPY_BYTES).toString("base64url");
  const loopbackPort = loopbackPortFor(provider, port);
  const redirectUri = `http://${LOOPBACK_HOST}:${loopbackPort}/callback`;

  const url = new URL(AUTHORIZE_ENDPOINTS[provider]);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return {
    codeChallenge,
    codeVerifier,
    port: loopbackPort,
    redirectUri,
    state,
    url: url.toString(),
  };
};

export interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly state: string;
}

export interface ExchangeDeps {
  readonly fetch?: typeof globalThis.fetch;
}

export interface ExchangedToken {
  readonly token: string;
}

// Relay the one-time code to the cloud authority over HTTPS (through the egress
// guard) and RECEIVE a cloud-minted session token. The POST targets the cloud
// gatekeeper host — never a provider host — so the daemon performs no client-side
// token exchange and makes no auth decision. The cloud authority performs
// the provider token exchange server-side and mints the session.
export const exchangeOneTimeCode = async (
  { code, codeVerifier, state }: ExchangeInput,
  deps: ExchangeDeps = {}
): Promise<ExchangedToken> => {
  const response = await guardedFetch(
    `${CLOUD_AUTHORITY_ORIGIN}${LOOPBACK_EXCHANGE_PATH}`,
    {
      body: JSON.stringify({ code, codeVerifier, state }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    { fetch: deps.fetch }
  );
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string") {
    throw new Error(
      "oauth loopback exchange: cloud authority returned no session token"
    );
  }
  return { token: body.token };
};

export interface SecureStoreSink {
  readonly save: (key: string, blob: string) => Promise<void> | void;
}

export interface PersistDeps {
  readonly secureStore?: SecureStoreSink;
}

export interface PersistedToken {
  readonly atRest: string;
}

// The no-plaintext FLOOR: seal the token in an AES-256-GCM envelope so the
// persisted artifact never contains the raw token. Full key custody (an
// Argon2id-derived key held in the OS keychain) and the cross-target
// no-plaintext baseline are a later story; here the envelope alone proves the
// cloud-minted token enters the secure store enveloped, never as plaintext.
const sealTokenEnvelope = (plaintext: string): string => {
  const key = randomBytes(AES_KEY_BYTES);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const envelope = {
    alg: "AES-256-GCM",
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: authTag.toString("base64"),
    v: 1,
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
};

// Hand the cloud-minted session token to the secure store. The persisted form is
// the envelope, never the raw token.
export const persistSessionToken = async (
  token: string,
  deps: PersistDeps = {}
): Promise<PersistedToken> => {
  const atRest = sealTokenEnvelope(token);
  if (deps.secureStore) {
    await deps.secureStore.save(SECURE_STORE_KEY, atRest);
  }
  return { atRest };
};

// Constant-time state compare over fixed-length digests of both inputs. Hashing
// first means the comparison never short-circuits on length and never branches
// on the secret — closing the timing side-channel a `===`/`!==` compare opens.
const stateMatches = (presented: string, expected: string): boolean => {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
};

export interface LoopbackCallbackOptions {
  readonly codeVerifier: string;
  // Optional override for the cloud-authority relay (tests inject an observable
  // exchange). Production omits it and relays via exchangeOneTimeCode.
  readonly exchange?: (code: string) => Promise<ExchangedToken>;
  readonly expectedState: string;
  readonly onToken: (token: string) => Promise<void> | void;
}

// Mount the loopback `/callback` route on a fastify instance. The handler
// validates `state` timing-safe, enforces single-use (the state/code is burned
// on first valid use so a replay fails closed), relays the one-time code to the
// cloud authority, and hands the cloud-minted token to the sink. A mismatched or
// replayed state — or a reused code — is rejected with no exchange and no token
// persisted. Content-type is set via `reply.type()`, never the header setter.
export const mountLoopbackCallback = (
  app: FastifyInstance,
  options: LoopbackCallbackOptions
): void => {
  const exchange =
    options.exchange ??
    ((code: string) =>
      exchangeOneTimeCode({
        code,
        codeVerifier: options.codeVerifier,
        state: options.expectedState,
      }));

  // Single-use: burned on the first valid presentation; a second presentation
  // (replay) fails closed.
  let consumed = false;

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/callback",
    async (request, reply) => {
      const { code, state } = request.query;

      if (consumed) {
        return reply
          .code(HTTP_CONFLICT)
          .type("text/html")
          .send(CALLBACK_REJECTED_HTML);
      }

      if (
        typeof code !== "string" ||
        typeof state !== "string" ||
        !stateMatches(state, options.expectedState)
      ) {
        return reply
          .code(HTTP_BAD_REQUEST)
          .type("text/html")
          .send(CALLBACK_REJECTED_HTML);
      }

      // Burn BEFORE the relay so a concurrent replay cannot also exchange.
      consumed = true;

      try {
        const { token } = await exchange(code);
        await options.onToken(token);
        return reply.type("text/html").send(CALLBACK_OK_HTML);
      } catch {
        return reply
          .code(HTTP_BAD_GATEWAY)
          .type("text/html")
          .send(CALLBACK_REJECTED_HTML);
      }
    }
  );
};

export interface LoopbackListener {
  readonly close: () => Promise<void>;
  readonly port: number;
  readonly url: string;
}

// Start the per-flow loopback listener, BOUND to the 127.0.0.1 loopback
// interface, serving the `/callback` route. A new transient listener per flow,
// distinct from the main daemon API listener.
export const startLoopbackListener = async (
  options: LoopbackCallbackOptions & { port: number }
): Promise<LoopbackListener> => {
  const fastify = (await import("fastify")).default;
  const app = fastify();
  mountLoopbackCallback(app, options);
  await app.listen({ host: LOOPBACK_HOST, port: options.port });
  return {
    close: () => app.close(),
    port: options.port,
    url: `http://${LOOPBACK_HOST}:${options.port}/callback`,
  };
};

export interface DeepLinkRegistration {
  readonly primaryCallback: "loopback";
  readonly stubbed: boolean;
}

// The custom-scheme deep-link is SUGAR only: the 127.0.0.1 loopback listener is
// the PRIMARY callback on every desktop OS. This is a no-op stub (Linux/Windows
// register nothing here; the macOS custom-scheme path is out of scope) and never
// displaces the loopback primary — and never throws.
export const registerDeepLinkScheme = (
  _platform: string
): DeepLinkRegistration => ({
  primaryCallback: "loopback",
  stubbed: true,
});
