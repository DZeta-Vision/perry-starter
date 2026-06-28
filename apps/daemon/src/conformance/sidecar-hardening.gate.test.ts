import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate (source leg) — the surreal sidecar is bound loopback-only
// with scoped non-root creds and denied capabilities. (The behavioral
// effectiveness leg lives in
// `apps/daemon/test/sidecar-hardening.acceptance.test.ts`.) Two static detectors
// over the daemon's surreal supervisor (`supervisor.ts`):
//   (a) the spawn-args carry `--bind 127.0.0.1:<port>` AND all three of
//       `--deny-guests`, `--deny-scripting`, `--deny-net`;
//   (b) the per-request DB query path authenticates with a scoped record-access
//       Bearer session and NEVER reads SURREAL_USER/SURREAL_PASS in the query
//       path (root/OWNER creds bypass row permissions). Reuses the
//       comment-stripped Bearer-not-root detector pattern from the data store's
//       security gate.
//
// Fact (not gated): there is no UDS bind flag at surreal v3.1.5 — the listener
// is TCP-loopback-only; loopback bind + scoped record-access creds + denied
// capabilities is the hardening floor.
//
// The mutation twin proves dropping any flag/bind, or a root-cred read, reddens.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
const DAEMON_SRC = resolve(HERE, ".."); // apps/daemon/src
const SUPERVISOR_FILE = resolve(DAEMON_SRC, "supervisor.ts");

// --- Detector A: loopback bind + all three deny capabilities in spawn-args ---

const REQUIRED_HARDENING = [
  "--bind",
  "127.0.0.1",
  "--deny-guests",
  "--deny-scripting",
  "--deny-net",
] as const;

const findMissingHardening = (source: string): string[] =>
  REQUIRED_HARDENING.filter((flag) => !source.includes(flag));

// --- Detector B: Bearer-not-root in the query path (comment-resistant) ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;

const usesBearerAuth = (source: string): boolean =>
  BEARER_AUTH_RE.test(stripJsComments(source));
const findRootCredentialReads = (source: string): string[] => {
  const code = stripJsComments(source);
  return ROOT_CREDENTIAL_RES.filter((re) => re.test(code)).map(
    (re) => re.source
  );
};

describe("the surreal sidecar supervisor is hardened at the source layer", () => {
  test("the spawn-args carry --bind 127.0.0.1 and all three deny capabilities", () => {
    const source = readFileSync(SUPERVISOR_FILE, "utf8");
    expect(findMissingHardening(source)).toEqual([]);
  });

  test("the per-request DB query path uses a scoped record-access Bearer session and reads no root credentials", () => {
    const source = readFileSync(SUPERVISOR_FILE, "utf8");
    expect(usesBearerAuth(source)).toBe(true);
    expect(findRootCredentialReads(source)).toEqual([]);
  });
});
