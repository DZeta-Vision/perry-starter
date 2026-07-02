import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

// Conformance gate — the daemon reports to Sentry via a HAND-ROLLED HTTP-envelope
// over the egress-guarded native `fetch`, never an in-process SDK:
//   (a) the envelope is byte-correct (newline-delimited; JSON items carry NO
//       `length`; log timestamp is epoch SECONDS; content_type exact);
//   (b) secret-bearing attributes are SCRUBBED before serialize (no leak on wire);
//   (c) the ingest host derived from the DSN is on the daemon EGRESS_ALLOWLIST and
//       the POST goes through `guardedFetch`;
//   (d) the daemon reporter source imports NO Sentry SDK / pino, and the real
//       tier-boundary guard passes on it.
//
// The mutation twin (sentry-envelope.mutation.test.ts) plants an off-list ingest
// host (blocked), an in-process-SDK import (guard reddens), a `length`-on-JSON-item
// corruption, and a non-scrubbing builder that leaks — each reddens.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const REPORTER_SRC = resolve(HERE, "..", "sentry-reporter.ts");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");

// A canonical DSN whose host is the pinned Sentry ingest host on the allowlist.
const DSN = "https://pubkey123@ingest.sentry.io/42";

interface ReporterModule {
  buildEnvelopeUrl: (dsn: string) => string | null;
  buildLogEnvelope: (input: {
    attributes?: Record<string, unknown>;
    body: string;
    level: string;
    nowMs?: number;
  }) => { envHeader: Record<string, unknown>; items: unknown[] };
  parseSentryDsn: (dsn: string) => { host: string } | null;
  reportEnvelopeToSentry: (
    dsn: string,
    envelope: unknown,
    deps?: { fetch?: typeof globalThis.fetch; audit?: (host: string) => void }
  ) => Promise<Response | null>;
  sentryIngestHost: (dsn: string) => string | null;
  serializeEnvelope: (envelope: unknown) => string;
}
interface EgressModule {
  EGRESS_ALLOWLIST: readonly string[];
  SENTRY_INGEST_HOST: string;
}

// An in-process Sentry-SDK / pino import specifier in an import position — the
// daemon reporter must contain none.
const FORBIDDEN_SDK_IMPORT =
  /\b(?:from|import)\s*\(?\s*["'](?:@sentry\/|pino)[^"']*["']/;

const importReporter = async (): Promise<ReporterModule> =>
  (await import("../sentry-reporter")) as unknown as ReporterModule;
const importEgress = async (): Promise<EgressModule> =>
  (await import("../egress-allowlist")) as unknown as EgressModule;

const runGuardScan = (file: string): number => {
  try {
    execFileSync(process.execPath, [GUARD, "--scan", file], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
};

describe("the daemon Sentry reporter emits a byte-correct, scrubbed, egress-guarded envelope with no SDK", () => {
  test("the log envelope is newline-delimited with an epoch-seconds timestamp and the exact content_type", async () => {
    const mod = await importReporter();
    const envelope = mod.buildLogEnvelope({
      attributes: { actor: "user_01" },
      body: "auth.sign_in",
      level: "info",
      nowMs: 1_700_000_000_000,
    });
    const serialized = mod.serializeEnvelope(envelope);
    const lines = serialized.split("\n");

    expect(lines).toHaveLength(3); // envHeader, itemHeader, payload
    const envHeader = JSON.parse(lines[0]);
    const itemHeader = JSON.parse(lines[1]);
    const payload = JSON.parse(lines[2]);

    expect(envHeader.sdk.name).toBe("perry-daemon");
    expect(itemHeader.type).toBe("log");
    expect(itemHeader.content_type).toBe(
      "application/vnd.sentry.items.log+json"
    );
    expect(payload.version).toBe(2);
    const log = payload.items[0];
    // Epoch SECONDS (float), not ms.
    expect(log.timestamp).toBe(1_700_000_000);
    expect(log.severity_number).toBe(9); // info
  });

  test("a JSON log item header carries NO `length` field (adding one corrupts ingest)", async () => {
    const mod = await importReporter();
    const envelope = mod.buildLogEnvelope({ body: "x", level: "info" });
    const serialized = mod.serializeEnvelope(envelope);
    const itemHeader = JSON.parse(serialized.split("\n")[1]);

    expect(itemHeader).not.toHaveProperty("length");
  });

  test("secret-bearing attributes are scrubbed before serialize — no raw secret on the wire", async () => {
    const mod = await importReporter();
    const envelope = mod.buildLogEnvelope({
      attributes: { actor: "user_01", token: "leak-me-tok" },
      body: "auth.sign_in",
      level: "info",
    });
    const serialized = mod.serializeEnvelope(envelope);
    const log = JSON.parse(serialized.split("\n")[2]).items[0];

    expect(log.attributes.actor).toBe("user_01");
    expect(log.attributes.token).toBe("[redacted]");
    expect(serialized).not.toContain("leak-me-tok");
  });

  test("the ingest URL is derived from the DSN and its host is on the daemon egress allowlist", async () => {
    const mod = await importReporter();
    const egress = await importEgress();

    const url = mod.buildEnvelopeUrl(DSN);
    expect(url).toBe(
      "https://ingest.sentry.io/api/42/envelope/?sentry_version=7&sentry_key=pubkey123"
    );
    expect(mod.sentryIngestHost(DSN)).toBe(egress.SENTRY_INGEST_HOST);
    expect(egress.EGRESS_ALLOWLIST).toContain(mod.sentryIngestHost(DSN));
  });

  test("reportEnvelopeToSentry POSTs the envelope to the allowlisted ingest host through guardedFetch", async () => {
    const mod = await importReporter();
    const fakeFetch = vi.fn(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    const envelope = mod.buildLogEnvelope({
      body: "auth.sign_in",
      level: "info",
    });

    await mod.reportEnvelopeToSentry(DSN, envelope, {
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fakeFetch.mock.calls[0] as [unknown, RequestInit];
    expect(String(input)).toContain("/api/42/envelope/");
    expect(String(input)).toContain("sentry_key=pubkey123");
    expect(init.method).toBe("POST");
  });

  test("the daemon reporter source imports no Sentry SDK / pino, and the tier-boundary guard passes on it", () => {
    const src = readFileSync(REPORTER_SRC, "utf8");

    expect(FORBIDDEN_SDK_IMPORT.test(src)).toBe(false);
    expect(runGuardScan(REPORTER_SRC)).toBe(0);
  });
});
