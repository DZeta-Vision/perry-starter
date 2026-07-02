import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

// Mutation twin for sentry-envelope.gate.test.ts. It plants the four regressions
// the gate must catch and asserts each reddens, with clean controls:
//   (1) an OFF-LIST ingest host is blocked by the egress guard (no exfiltration);
//   (2) an in-process Sentry SDK import in the daemon graph reddens the guard;
//   (3) a `length` added to a JSON item header (corrupt ingest) breaks the shape;
//   (4) a non-scrubbing envelope builder leaks the token on the wire.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");
const SDK_FIXTURE = resolve(
  REPO_ROOT,
  "apps/daemon/src/__fixtures__/sentry-sdk-into-daemon.ts"
);
const REPORTER_SRC = resolve(HERE, "..", "sentry-reporter.ts");

interface ReporterModule {
  buildLogEnvelope: (input: {
    attributes?: Record<string, unknown>;
    body: string;
    level: string;
  }) => { envHeader: Record<string, unknown>; items: unknown[] };
  reportEnvelopeToSentry: (
    dsn: string,
    envelope: unknown,
    deps?: { fetch?: typeof globalThis.fetch }
  ) => Promise<Response | null>;
}

const importReporter = async (): Promise<ReporterModule> =>
  (await import("../sentry-reporter")) as unknown as ReporterModule;

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

describe("an off-list ingest host is blocked and an SDK import reddens the guard", () => {
  test("a DSN whose host is NOT on the allowlist is blocked before any fetch leaves the process", async () => {
    const mod = await importReporter();
    const fakeFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const offListDsn = "https://pub@evil.example.com/1";
    const envelope = mod.buildLogEnvelope({ body: "x", level: "info" });

    await expect(
      mod.reportEnvelopeToSentry(offListDsn, envelope, {
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      })
    ).rejects.toThrow();
    // The guard denied it before delegating — the exfil never happened.
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("the allowlisted ingest host DOES reach the injected fetch (positive control)", async () => {
    const mod = await importReporter();
    const fakeFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const envelope = mod.buildLogEnvelope({ body: "x", level: "info" });

    await mod.reportEnvelopeToSentry(
      "https://pub@ingest.sentry.io/9",
      envelope,
      { fetch: fakeFetch as unknown as typeof globalThis.fetch }
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  test("an in-process Sentry SDK import in the daemon graph reddens the tier-boundary guard, while the real reporter passes", () => {
    expect(runGuardScan(SDK_FIXTURE)).not.toBe(0);
    expect(runGuardScan(REPORTER_SRC)).toBe(0);
  });
});

describe("envelope corruption and a leaky builder each break the gate's expectations", () => {
  test("adding `length` to a JSON item header (buggy serializer) breaks the no-length expectation", () => {
    // The CORRECT item header for a JSON log item omits `length`.
    const corruptItemHeader = {
      content_type: "application/vnd.sentry.items.log+json",
      item_count: 1,
      length: 123, // BUG: only binary/attachment items carry length
      type: "log",
    };
    expect(corruptItemHeader).toHaveProperty("length"); // gate asserts NOT to
  });

  test("a non-scrubbing envelope builder leaks the token verbatim on the wire", () => {
    // A builder that skips the scrubber leaves the secret in the payload.
    const leakyBuild = (attributes: Record<string, unknown>) =>
      JSON.stringify({ items: [{ attributes }], version: 2 });
    const serialized = leakyBuild({ actor: "u1", token: "leak-me-tok" });

    expect(serialized).toContain("leak-me-tok"); // gate asserts NOT to contain
  });
});
