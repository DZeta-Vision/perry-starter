// The per-launch bearer token: the compensating control that makes loopback
// safe to treat as untrusted. A fresh 256-bit token is minted on every daemon
// launch and delivered OUT-OF-BAND in the loopback URL the human opens — it is
// never served back over the listener it protects (see the no-disclosure
// invariant enforced by the conformance gates). The browser reads it from the
// URL fragment (which is never transmitted to the server) and presents it as
// `Authorization: Bearer <token>` on every request to the bearer-gated API.

// 256 bits of entropy. base64url-encoded (no padding) this is 43 characters, so
// the minted token clears any reasonable length floor.
const BEARER_BYTES = 32;

// Encode raw bytes as unpadded base64url so the token embeds cleanly in a URL.
const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

// Mint a fresh per-launch bearer from the platform CSPRNG. Two independent
// calls return different tokens — the per-launch uniqueness the gate asserts.
export const mintBearer = (): string => {
  const bytes = new Uint8Array(BEARER_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export interface LoopbackUrlParts {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

// Compose the loopback URL the daemon prints on start. The bearer rides in the
// URL fragment (`#token=…`): the fragment is the out-of-band channel the human
// reads, and the browser never sends it to the server, so the token cannot leak
// into request logs or be echoed by the listener.
export const composeLoopbackUrl = ({
  host,
  port,
  token,
}: LoopbackUrlParts): string => `http://${host}:${port}/#token=${token}`;
