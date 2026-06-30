// The daemon's outbound-fetch egress allowlist: a guard around native `fetch`
// so a compromised dependency cannot exfiltrate. Every outbound call the daemon
// makes goes through `guardedFetch`, which permits only HTTPS requests to a host
// on the static allowlist and blocks everything else — AND re-validates every
// redirect hop, because native `fetch` follows 3xx transparently and an
// allowlisted host could otherwise bounce the request to an off-list one.
// Plain TS over native `fetch` — no in-process SDK or WASM.
//
// `fetch` and the audit sink are injectable via the optional `deps` arg, so a
// test can drive the guard with a fake fetch and observe denials WITHOUT
// stubbing the process-wide `globalThis.fetch` (which races concurrently
// scheduled test files). Production callers omit `deps` and get native `fetch`
// plus the real audit. The default `fetch` is resolved at call time so it never
// captures a stale reference.

const HTTPS = "https:";
const MAX_REDIRECT_HOPS = 5;

// Host-pinned allowlist, sourced from the deployment topology — not invented:
//   - the cloud gatekeeper Worker (the daemon's single cloud egress target),
//   - the updater host (release-channel downloads),
//   - the GitHub + Google OAuth authorization + token hosts.
// Add the Sentry-ingest host here at deploy time. The breach-range API is
// intentionally excluded: breach checks run on the cloud authority, so that
// egress belongs to the Worker, not the daemon — add it here only if a
// daemon-side breach-check path is actually built. The OAuth-provider host
// strings are a deploy-time host-set; the host-pinned-HTTPS contract is what
// this allowlist enforces.
export const EGRESS_ALLOWLIST: readonly string[] = [
  "api.perryts.com",
  "hub.perryts.com",
  "github.com",
  "api.github.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
];

// Emit a structured audit record for a blocked egress attempt. A blocked
// destination is a security-relevant event, so it is recorded (not swallowed)
// before the guard throws.
export const auditEgressDenied = (host: string): void => {
  process.stderr.write(`${JSON.stringify({ event: "egress.denied", host })}\n`);
};

export interface GuardedFetchDeps {
  readonly audit?: (host: string) => void;
  readonly fetch?: typeof globalThis.fetch;
}

const urlOf = (input: string | URL | Request): URL => {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
};

const isRedirectStatus = (status: number): boolean =>
  status >= 300 && status < 400;

// HTTPS + host ∈ allowlist, else audit and throw. Applied to the initial URL
// and to every redirect target.
const assertAllowed = (url: URL, audit: (host: string) => void): void => {
  if (url.protocol !== HTTPS || !EGRESS_ALLOWLIST.includes(url.hostname)) {
    audit(url.hostname);
    throw new Error(`egress denied: ${url.protocol}//${url.hostname}`);
  }
};

export const guardedFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
  deps: GuardedFetchDeps = {}
): Promise<Response> => {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const audit = deps.audit ?? auditEgressDenied;

  let target = urlOf(input);
  assertAllowed(target, audit);

  // Follow redirects manually so each hop is re-validated before it is fetched.
  let response = await doFetch(input, { ...init, redirect: "manual" });
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    if (!isRedirectStatus(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    target = new URL(location, target);
    assertAllowed(target, audit);
    response = await doFetch(target, { ...init, redirect: "manual" });
  }

  if (isRedirectStatus(response.status)) {
    throw new Error(`egress denied: too many redirects to ${target.hostname}`);
  }
  return response;
};
