// The single-sourced AG-UI SSE event-subset contract.
//
// This is the ONE wire contract every AI leg emits and consumes — the browser
// client, the cloud Worker floor, and the on-device daemon sidecar. It is
// HAND-DEFINED on purpose: the upstream generative-streaming SDK and its event
// schema bundle are foreclosed in the Perry daemon build (they ship prebuilt JS
// and pull a runtime schema library — an in-process bundle the daemon cannot
// link, per AD-3). So the daemon hand-emits these frames as strings, and the CI
// conformance gate (which runs in full Node, where the bundle is legal) parses
// every hand-emitted frame against the real upstream schemas. This module names
// no foreclosed package specifier, so it stays clean under the tier-boundary
// daemon-graph guard.
//
// The subset is pinned; the paired conformance gate re-runs on any upstream
// version bump so the contract cannot silently drift as the beta moves.

// --- EventType string literals (the hand-emitted subset) ---
// Hard-coded because the upstream EventType enum cannot be imported into the
// daemon graph. These literals are byte-identical to the upstream enum values.
export const RUN_STARTED = "RUN_STARTED";
export const RUN_FINISHED = "RUN_FINISHED";
export const RUN_ERROR = "RUN_ERROR";
export const TEXT_MESSAGE_START = "TEXT_MESSAGE_START";
export const TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT";
export const TEXT_MESSAGE_END = "TEXT_MESSAGE_END";
export const TOOL_CALL_START = "TOOL_CALL_START";
export const TOOL_CALL_ARGS = "TOOL_CALL_ARGS";
export const TOOL_CALL_END = "TOOL_CALL_END";
export const STEP_STARTED = "STEP_STARTED";
export const STEP_FINISHED = "STEP_FINISHED";

// The complete emitted subset, in canonical order. Anything outside this list is
// not part of the perry-starter AI wire contract.
export const AG_UI_SUBSET_EVENT_TYPES = [
  RUN_STARTED,
  RUN_FINISHED,
  RUN_ERROR,
  TEXT_MESSAGE_START,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TOOL_CALL_START,
  TOOL_CALL_ARGS,
  TOOL_CALL_END,
  STEP_STARTED,
  STEP_FINISHED,
] as const;

export type AgUiSubsetEventType = (typeof AG_UI_SUBSET_EVENT_TYPES)[number];

// Per-event REQUIRED fields (the canonical upstream requirements for the subset).
// Used to hand-validate a frame before the daemon writes it — a cheap
// belt-and-suspenders guard so a malformed frame never reaches the wire even
// though the CI conformance gate is the authoritative check.
export const REQUIRED_FIELDS: Record<AgUiSubsetEventType, readonly string[]> = {
  [RUN_STARTED]: ["threadId", "runId"],
  [RUN_FINISHED]: ["threadId", "runId"],
  [RUN_ERROR]: ["message"],
  [TEXT_MESSAGE_START]: ["messageId"],
  [TEXT_MESSAGE_CONTENT]: ["messageId", "delta"],
  [TEXT_MESSAGE_END]: ["messageId"],
  [TOOL_CALL_START]: ["toolCallId", "toolCallName"],
  [TOOL_CALL_ARGS]: ["toolCallId", "delta"],
  [TOOL_CALL_END]: ["toolCallId"],
  [STEP_STARTED]: ["stepName"],
  [STEP_FINISHED]: ["stepName"],
} as const;

// --- normalized account-locale directive (FIRST-CLASS contract field) ---
// A resolved locale tag, snapshotted once per turn from the write-through
// active-locale store and injected identically into every AI leg's model system
// context by one shared request-assembly function. A pre-auth / no-account turn
// resolves to DEFAULT_LOCALE. This is a defined field of the contract, never a
// tolerated passthrough extra.
export type LocaleDirective = string;
export const DEFAULT_LOCALE: LocaleDirective = "en";

// --- inference-provenance (FIRST-CLASS optional contract field) ---
// The effective finishing locus of a turn, stamped by the routing proxy so the
// UI can render an honest "via cloud" tag. A defined field, not a passthrough
// extra. Absent when provenance is not being surfaced.
export const PROVENANCE_LOCAL = "local";
export const PROVENANCE_CLOUD = "cloud";
export type InferenceProvenance =
  | typeof PROVENANCE_LOCAL
  | typeof PROVENANCE_CLOUD;

// The stable, provider-agnostic terminal error code the whole surface degrades
// to when no AI leg can serve. Rendered by the UI as a calm localized line
// (`ai.error.<code>`); it never carries a provider name, engine id, upstream
// status, or stack.
export const ASSISTANT_UNAVAILABLE = "ASSISTANT_UNAVAILABLE";

// --- Typed frame shapes ---
// Each carries its required fields; optional `locale`/`provenance` are the two
// first-class perry contract fields. `timestamp`/`model` may ride along as
// tolerated upstream extras but are never required by this contract.

export interface RunStartedFrame {
  readonly locale?: LocaleDirective;
  readonly runId: string;
  readonly threadId: string;
  readonly type: typeof RUN_STARTED;
}

export interface TextMessageStartFrame {
  readonly messageId: string;
  readonly role?: string;
  readonly type: typeof TEXT_MESSAGE_START;
}

export interface TextMessageContentFrame {
  readonly delta: string;
  readonly messageId: string;
  readonly type: typeof TEXT_MESSAGE_CONTENT;
}

export interface TextMessageEndFrame {
  readonly messageId: string;
  readonly type: typeof TEXT_MESSAGE_END;
}

export interface ToolCallStartFrame {
  readonly parentMessageId?: string;
  readonly toolCallId: string;
  readonly toolCallName: string;
  readonly type: typeof TOOL_CALL_START;
}

export interface ToolCallArgsFrame {
  readonly delta: string;
  readonly toolCallId: string;
  readonly type: typeof TOOL_CALL_ARGS;
}

export interface ToolCallEndFrame {
  readonly toolCallId: string;
  readonly type: typeof TOOL_CALL_END;
}

export interface RunFinishedFrame {
  // The effective finishing locus (first-class provenance field).
  readonly provenance?: InferenceProvenance;
  readonly runId: string;
  readonly threadId: string;
  readonly type: typeof RUN_FINISHED;
}

export interface RunErrorFrame {
  readonly code?: string;
  readonly message: string;
  readonly type: typeof RUN_ERROR;
}

export type AgUiFrame =
  | RunStartedFrame
  | TextMessageStartFrame
  | TextMessageContentFrame
  | TextMessageEndFrame
  | ToolCallStartFrame
  | ToolCallArgsFrame
  | ToolCallEndFrame
  | RunFinishedFrame
  | RunErrorFrame;

// --- SSE serialization ---
// EXACTLY the upstream toServerSentEventsStream byte format: each event is one
// `data: <json>\n\n` frame; the stream simply closes after RUN_FINISHED — there
// is NO `[DONE]` sentinel (that is a client-side convenience, never emitted).
export const SSE_TERMINATOR = "\n\n";

export const frame = (event: AgUiFrame): string =>
  `data: ${JSON.stringify(event)}${SSE_TERMINATOR}`;

// Parse a single `data: …` line back to the event object (CI/consumer side).
export const parseFrame = (line: string): Record<string, unknown> => {
  const payload = line.startsWith("data: ")
    ? line.slice("data: ".length)
    : line;
  return JSON.parse(payload) as Record<string, unknown>;
};

// Hand-validate a frame's required fields before emit. Returns the list of
// missing required fields (empty = valid). The CI conformance gate is the
// authoritative schema check; this is the daemon's cheap pre-emit guard.
export const missingRequiredFields = (
  event: AgUiFrame | ({ readonly type: string } & Record<string, unknown>)
): readonly string[] => {
  const required = REQUIRED_FIELDS[event.type as AgUiSubsetEventType];
  if (required === undefined) {
    return ["type"]; // an event outside the subset is itself invalid.
  }
  const record = event as Record<string, unknown>;
  return required.filter((key) => {
    const value = record[key];
    return value === undefined || value === null;
  });
};

// --- Inbound RunAgentInput (hand-validated; the schema is the CI-tier spec) ---
// The browser POSTs an AG-UI RunAgentInput. The daemon cannot import the upstream
// schema, so it hand-validates the shape. SECURITY: `forwardedProps`/`data` are
// attacker-controlled and are NEVER spread into the model call — only the
// allow-listed fields below cross into inference.
export interface RunAgentInput {
  readonly messages: readonly unknown[];
  readonly parentRunId?: string;
  readonly runId: string;
  readonly threadId: string;
  readonly tools: readonly unknown[];
}

export const parseRunAgentInput = (body: unknown): RunAgentInput => {
  if (typeof body !== "object" || body === null) {
    throw new Error("run agent input: body is not an object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.threadId !== "string" || typeof b.runId !== "string") {
    throw new Error("run agent input: missing threadId/runId");
  }
  if (!(Array.isArray(b.messages) && Array.isArray(b.tools))) {
    throw new Error("run agent input: messages/tools must be arrays");
  }
  // Allow-list ONLY named fields — never carry forwardedProps/data forward.
  const input: RunAgentInput = {
    threadId: b.threadId,
    runId: b.runId,
    messages: b.messages,
    tools: b.tools,
  };
  return typeof b.parentRunId === "string"
    ? { ...input, parentRunId: b.parentRunId }
    : input;
};

// --- Normalized turn request (the one shared request-assembly input) ---
// Both AI legs (local sidecar, cloud floor) are driven from this one normalized
// shape so the locale and the retrieved RAG context are injected identically on
// each leg by one shared assembly function. The routing proxy (Story 4.5) selects
// the leg; this is the provider-agnostic request every leg receives.
export interface AssistantTurnRequest {
  // Snapshotted once per turn; injected identically on every leg.
  readonly locale: LocaleDirective;
  readonly prompt: string;
  // Retrieved local-document context (Story 4.6 RAG), injected identically.
  readonly retrievedContext?: readonly string[];
  readonly runId: string;
  readonly threadId: string;
}
