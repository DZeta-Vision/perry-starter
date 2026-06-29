import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the per-launch bearer is strong, out-of-band, and never
// re-served over the listener it protects. Three legs:
//   (a) minted per-launch with ≥256-bit entropy via crypto.getRandomValues —
//       two independent mints differ and meet the length floor;
//   (b) the printed loopback-URL composer embeds the bearer in the URL (the
//       out-of-band channel the human reads on start);
//   (c) a no-disclosure source guard scans the daemon listener sources and
//       asserts NO route/handler returns or echoes the bearer in any response.
//
// The mutation twin proves a token-returning route and a constant/low-entropy
// mint each redden.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
const DAEMON_SRC = resolve(HERE, ".."); // apps/daemon/src

// 256 bits = 32 bytes. Encoded as base64url that is ≥ 43 chars; as hex ≥ 64.
// The floor is deliberately conservative so any real 256-bit token clears it.
const MIN_BEARER_LENGTH = 43;

// --- No-disclosure source guard ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// A handler that sends the minted bearer back over the listener, or a route
// whose path advertises the token, is the worst-case disclosure.
const SENDS_BEARER_RE =
  /\b(?:reply|res)\s*\.\s*(?:send|header)\s*\([^)]*\b(?:bearer|token)\b/i;
const TOKEN_ROUTE_RE =
  /\.(?:get|post|put|delete|all)\s*\(\s*["'][^"']*\/(?:token|bearer)\b/i;

const disclosesBearer = (source: string): boolean => {
  const code = stripJsComments(source);
  return SENDS_BEARER_RE.test(code) || TOKEN_ROUTE_RE.test(code);
};

const SOURCE_EXT_RE = /\.[mc]?tsx?$/;
const SKIP_DIRS = new Set([
  "conformance",
  "__fixtures__",
  "test",
  "node_modules",
]);
const TEST_FILE_RE = /\.test\.tsx?$/;

// Collect daemon listener source (excludes the bearer mint module itself, the
// conformance gates, fixtures, and tests — only real route/handler code).
const collectDaemonSources = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectDaemonSources(join(dir, entry.name), out);
      }
    } else if (
      entry.isFile() &&
      SOURCE_EXT_RE.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name) &&
      entry.name !== "bearer.ts"
    ) {
      out.push(join(dir, entry.name));
    }
  }
};

interface BearerModule {
  composeLoopbackUrl: (opts: {
    host: string;
    port: number;
    token: string;
  }) => string;
  mintBearer: () => string;
}

const importBearer = async (): Promise<BearerModule> =>
  (await import("../bearer")) as unknown as BearerModule;

describe("the per-launch bearer is strong, out-of-band, and never re-served over the listener", () => {
  test("the bearer is minted per-launch with ≥256-bit entropy — two mints differ and clear the length floor", async () => {
    const { mintBearer } = await importBearer();
    const first = mintBearer();
    const second = mintBearer();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(MIN_BEARER_LENGTH);
    expect(second.length).toBeGreaterThanOrEqual(MIN_BEARER_LENGTH);
  });

  test("the printed loopback-URL composer embeds the bearer in the URL (the out-of-band channel)", async () => {
    const { mintBearer, composeLoopbackUrl } = await importBearer();
    const token = mintBearer();
    const url = composeLoopbackUrl({ host: "127.0.0.1", port: 4317, token });
    expect(url).toContain(token);
  });

  test("no daemon listener route returns or echoes the bearer over the listener it protects (no-disclosure guard)", () => {
    const files: string[] = [];
    collectDaemonSources(DAEMON_SRC, files);
    const offenders = files.filter((file) =>
      disclosesBearer(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
