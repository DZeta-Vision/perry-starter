// The daemon's outbound-fetch egress allowlist: a guard around native `fetch`
// so a compromised dependency cannot exfiltrate. Every outbound call the daemon
// makes goes through `guardedFetch`, which permits only HTTPS requests to a
// host on the static allowlist and blocks everything else. Plain TS over native
// `fetch` — no in-process SDK or WASM.
//
// The named self-import below is deliberate: routing the internal audit call
// through the module's own export binding keeps the audit observable to callers
// (and tests) that wrap `auditEgressDenied`, rather than burying it behind a
// local reference.
import { auditEgressDenied as auditDenied } from "./egress-allowlist";

const HTTPS = "https:";

// Host-pinned allowlist, sourced from the deployment topology — not invented:
//   - the cloud gatekeeper Worker (the daemon's single cloud egress target),
//   - the updater host (release-channel downloads).
// Add the Sentry-ingest host and configured OAuth-provider hosts here at deploy
// time. The breach-range API is intentionally excluded: breach checks run on
// the cloud authority, so that egress belongs to the Worker, not the daemon —
// add it here only if a daemon-side breach-check path is actually built.
export const EGRESS_ALLOWLIST: readonly string[] = [
  "api.perryts.com",
  "hub.perryts.com",
];

// Emit a structured audit record for a blocked egress attempt. A blocked
// destination is a security-relevant event, so it is recorded (not swallowed)
// before the guard throws.
export const auditEgressDenied = (host: string): void => {
  process.stderr.write(`${JSON.stringify({ event: "egress.denied", host })}\n`);
};

const urlOf = (input: string | URL | Request): URL => {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
};

// Permit only HTTPS requests to an allowlisted host; a miss is audited and
// rejected. Resolves the global `fetch` at call time so it never captures a
// stale reference.
export const guardedFetch = (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = urlOf(input);
  if (url.protocol !== HTTPS || !EGRESS_ALLOWLIST.includes(url.hostname)) {
    auditDenied(url.hostname);
    return Promise.reject(
      new Error(`egress denied: ${url.protocol}//${url.hostname}`)
    );
  }
  return globalThis.fetch(input, init);
};
