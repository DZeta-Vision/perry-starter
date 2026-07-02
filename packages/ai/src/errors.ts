import type { RunErrorFrame } from "./ag-ui-contract";
import { ASSISTANT_UNAVAILABLE, RUN_ERROR } from "./ag-ui-contract";

// Error normalization for the AI surface.
//
// A model / upstream failure must NEVER leak a provider name, model id, upstream
// HTTP status, or stack to the user surface. The raw detail is logged only; the
// wire carries a stable, provider-agnostic terminal RUN_ERROR whose `code` the UI
// renders as a calm localized line (`ai.error.<code>`). The default code is
// ASSISTANT_UNAVAILABLE — the whole-surface degradation code.

export type ErrorSink = (line: string) => void;

// Cross-tier safe default sink: writes to stderr where a process exists (daemon /
// Worker / CI), no-ops in the browser (no `process`). Never `console` (lint) and
// never the user surface.
const defaultSink: ErrorSink = (line) => {
  if (
    typeof process !== "undefined" &&
    typeof process.stderr?.write === "function"
  ) {
    process.stderr.write(line);
  }
};

// Log the raw upstream detail out-of-band (audit only).
export const logRawUpstream = (
  error: unknown,
  sink: ErrorSink = defaultSink
): void => {
  const detail = error instanceof Error ? error.message : String(error);
  sink(`${JSON.stringify({ event: "ai.upstream.error", detail })}\n`);
};

// The normalized terminal error frame. Carries ONLY the stable code and a generic
// message — no provider id, no status, no stack.
export const normalizedRunErrorFrame = (
  error: unknown,
  code: string = ASSISTANT_UNAVAILABLE,
  sink: ErrorSink = defaultSink
): RunErrorFrame => {
  logRawUpstream(error, sink);
  return { type: RUN_ERROR, message: "The assistant is unavailable.", code };
};
