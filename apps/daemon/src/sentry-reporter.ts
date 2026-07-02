// The daemon's Sentry path — a HAND-ROLLED HTTP-envelope reporter over native
// `fetch`, NOT an in-process SDK.
//
// The Perry integration law forecloses any in-process npm-SDK/WASM/prebuilt-JS in
// the native binary, so the daemon MUST NOT import the Sentry SDK or pino. Instead
// it reproduces the on-the-wire envelope byte format by hand and POSTs it through
// the egress-guarded `guardedFetch`, so the ingest host is re-checked against the
// allowlist (a compromised dependency cannot exfiltrate to an off-list host). The
// tier-boundary build guard fails the daemon graph if any Sentry-SDK / pino
// specifier appears here — this module names none.
//
// Redaction (the NFR floor) runs BEFORE serialize: every attribute/extra is passed
// through the shared secret scrubber, so a token/password/cookie never rides the
// envelope. The daemon also emits the SAME logical event as structured JSON on
// stderr (pino is unavailable), scrubbed identically.

import { scrubSecrets } from "@perry-starter/env/scrub";
import { type GuardedFetchDeps, guardedFetch } from "./egress-allowlist";

// The daemon's own SDK identity in the envelope header (not a Sentry package).
const DAEMON_SDK = { name: "perry-daemon", version: "0.0.0" } as const;

// The wire version the ingest auth query-string pins.
const SENTRY_API_VERSION = "7";

export type DaemonLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

// OTel-style severity numbers, separate from the string level (info=9, error=17…).
const SEVERITY_NUMBER: Readonly<Record<DaemonLogLevel, number>> = {
  debug: 5,
  error: 17,
  fatal: 21,
  info: 9,
  trace: 1,
  warn: 13,
};

export interface SentryDsnParts {
  readonly host: string;
  readonly path: string;
  readonly port: string;
  readonly projectId: string;
  readonly protocol: string;
  readonly publicKey: string;
}

// An envelope item = [itemHeader, payload]. JSON items carry NO `length` in the
// item header — only binary/attachment items do; adding one corrupts ingest.
export type EnvelopeItem = readonly [
  Record<string, unknown>,
  Record<string, unknown>,
];

export interface SentryEnvelope {
  readonly envHeader: Record<string, unknown>;
  readonly items: readonly EnvelopeItem[];
}

// Parse `<scheme>://<publicKey>@<host>[:port]/[<path>/]<projectId>` into its parts.
// Returns null for a malformed/absent DSN (the reporter then no-ops).
export const parseSentryDsn = (dsn: string): SentryDsnParts | null => {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const projectId = segments.pop();
  if (publicKey === "" || projectId === undefined) {
    return null;
  }
  return {
    host: url.hostname,
    path: segments.join("/"),
    port: url.port ? `:${url.port}` : "",
    projectId,
    protocol: url.protocol,
    publicKey,
  };
};

// The ingest host — the value that MUST be on the daemon egress allowlist.
export const sentryIngestHost = (dsn: string): string | null =>
  parseSentryDsn(dsn)?.host ?? null;

// Build the ingest envelope URL with query-string auth (NOT an X-Sentry-Auth
// header — the SDK avoids it to dodge CORS preflight, and query-string is the
// right shape for native fetch).
export const buildEnvelopeUrl = (dsn: string): string | null => {
  const parts = parseSentryDsn(dsn);
  if (!parts) {
    return null;
  }
  const base = `${parts.protocol}//${parts.host}${parts.port}${parts.path ? `/${parts.path}` : ""}/api/`;
  return `${base}${parts.projectId}/envelope/?sentry_version=${SENTRY_API_VERSION}&sentry_key=${parts.publicKey}`;
};

// Byte-correct serializer: newline-delimited UTF-8. Line 1 = env header JSON; then
// per item `\n<itemHeader>\n<payload>`. JSON items carry no length prefix.
export const serializeEnvelope = (envelope: SentryEnvelope): string => {
  let out = JSON.stringify(envelope.envHeader);
  for (const [itemHeader, payload] of envelope.items) {
    out += `\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}`;
  }
  return out;
};

export interface DaemonLogInput {
  readonly attributes?: Record<string, unknown>;
  readonly body: string;
  readonly level: DaemonLogLevel;
  readonly nowMs?: number;
}

// Build the structured-LOG envelope (the "event type + actor" line). The
// timestamp is EPOCH SECONDS (float). Attributes are SCRUBBED before they enter
// the payload, so no secret ever reaches the wire.
export const buildLogEnvelope = (input: DaemonLogInput): SentryEnvelope => {
  const nowMs = input.nowMs ?? Date.now();
  const log = {
    attributes: scrubSecrets(input.attributes ?? {}),
    body: input.body,
    level: input.level,
    severity_number: SEVERITY_NUMBER[input.level],
    timestamp: nowMs / 1000,
  };
  return {
    envHeader: { sdk: DAEMON_SDK },
    items: [
      [
        {
          content_type: "application/vnd.sentry.items.log+json",
          item_count: 1,
          type: "log",
        },
        { items: [log], version: 2 },
      ],
    ],
  };
};

export interface DaemonEventInput {
  readonly error: Error;
  readonly extra?: Record<string, unknown>;
  readonly nowMs?: number;
}

// A 32-char hex event id (uuid4 without dashes) — the daemon uses Web Crypto.
const eventId = (): string => crypto.randomUUID().replace(/-/g, "");

// Build the EVENT (exception) envelope. `extra` is SCRUBBED before it enters the
// payload.
export const buildEventEnvelope = (input: DaemonEventInput): SentryEnvelope => {
  const nowMs = input.nowMs ?? Date.now();
  const id = eventId();
  return {
    envHeader: {
      event_id: id,
      sdk: DAEMON_SDK,
      sent_at: new Date(nowMs).toISOString(),
    },
    items: [
      [
        { type: "event" },
        {
          event_id: id,
          exception: {
            values: [{ type: input.error.name, value: input.error.message }],
          },
          extra: scrubSecrets(input.extra ?? {}),
          level: "error",
          timestamp: nowMs / 1000,
        },
      ],
    ],
  };
};

// POST a serialized envelope through the egress guard. The guard re-validates the
// ingest host against the allowlist (and every redirect hop), so an off-list DSN
// host is BLOCKED before any request leaves the process. Returns null when the DSN
// is malformed (nothing sent).
export const reportEnvelopeToSentry = async (
  dsn: string,
  envelope: SentryEnvelope,
  deps: GuardedFetchDeps = {}
): Promise<Response | null> => {
  const url = buildEnvelopeUrl(dsn);
  if (!url) {
    return null;
  }
  return await guardedFetch(
    url,
    {
      body: serializeEnvelope(envelope),
      headers: { "content-type": "application/x-sentry-envelope" },
      method: "POST",
    },
    deps
  );
};

// Emit the SAME logical event as structured JSON on stderr — the daemon's pino
// replacement. Scrubbed identically so the local log never leaks a secret either.
export const emitDaemonLog = (input: DaemonLogInput): void => {
  const record = {
    attributes: scrubSecrets(input.attributes ?? {}),
    body: input.body,
    event: "daemon.log",
    level: input.level,
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

// The wired daemon error path: always emit a scrubbed structured-JSON line, and
// best-effort report the exception envelope to Sentry when a DSN is configured
// (through the egress guard). Never throws — reporting must not mask the original
// failure.
export const reportDaemonError = async (
  error: Error,
  opts: { readonly dsn?: string } = {}
): Promise<void> => {
  emitDaemonLog({
    attributes: { error_name: error.name, error_message: error.message },
    body: "daemon.error",
    level: "error",
  });
  const dsn = opts.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }
  try {
    await reportEnvelopeToSentry(dsn, buildEventEnvelope({ error }));
  } catch {
    // A blocked/failed ingest POST must never break the daemon; the structured
    // stderr line above is the durable local record.
  }
};
