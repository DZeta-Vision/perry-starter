import {
  EventSchemas,
  RunFinishedEventSchema,
  RunStartedEventSchema,
} from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  type AgUiFrame,
  DEFAULT_LOCALE,
  frame,
  missingRequiredFields,
  PROVENANCE_CLOUD,
  parseFrame,
  parseRunAgentInput,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TEXT_MESSAGE_START,
  TOOL_CALL_ARGS,
  TOOL_CALL_END,
  TOOL_CALL_START,
} from "../ag-ui-contract";

// AD-17 AG-UI event-subset conformance gate.
//
// This runs in the CI/Node tier (NOT the daemon binary), the ONE place the
// upstream event schema bundle may be imported. It proves the hand-emitted
// subset (single-sourced in ../ag-ui-contract.ts) is byte-format valid against
// the real @ag-ui/core@0.0.52 schemas: every frame parses, RUN_FINISHED is the
// terminal event, there is no `[DONE]` sentinel, and the first-class perry
// contract fields (locale directive + inference provenance) ride along validly.
//
// The mutation twin (ag-ui-subset.mutation.test.ts) proves the gate is
// anti-vacuous: a known-bad frame (toolName vs toolCallName, a missing required
// field, an unknown type) makes EventSchemas.parse throw.

// A well-formed text turn, in canonical order, with the two first-class fields
// stamped: locale on RUN_STARTED, provenance on RUN_FINISHED.
const textTurn = (): AgUiFrame[] => {
  const threadId = "thread-1";
  const runId = "run-1";
  const messageId = "msg-1";
  return [
    { type: RUN_STARTED, threadId, runId, locale: DEFAULT_LOCALE },
    { type: TEXT_MESSAGE_START, messageId, role: "assistant" },
    { type: TEXT_MESSAGE_CONTENT, messageId, delta: "Hello" },
    { type: TEXT_MESSAGE_CONTENT, messageId, delta: ", world" },
    { type: TEXT_MESSAGE_END, messageId },
    { type: RUN_FINISHED, threadId, runId, provenance: PROVENANCE_CLOUD },
  ];
};

// A tool turn inserts the tool-call trio before RUN_FINISHED.
const toolTurn = (): AgUiFrame[] => {
  const threadId = "thread-2";
  const runId = "run-2";
  const toolCallId = "call-1";
  return [
    { type: RUN_STARTED, threadId, runId },
    { type: TOOL_CALL_START, toolCallId, toolCallName: "search_docs" },
    { type: TOOL_CALL_ARGS, toolCallId, delta: '{"q":"' },
    { type: TOOL_CALL_END, toolCallId },
    { type: RUN_FINISHED, threadId, runId },
  ];
};

test("every frame of a well-formed text turn serializes and parses against @ag-ui/core EventSchemas", () => {
  for (const event of textTurn()) {
    const line = frame(event);
    // Byte format: exactly `data: <json>\n\n`.
    expect(line.startsWith("data: ")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(true);
    const parsed = EventSchemas.parse(parseFrame(line));
    expect(parsed.type).toBe(event.type);
  }
});

test("a tool turn (TOOL_CALL_START/ARGS/END) validates with toolCallName", () => {
  for (const event of toolTurn()) {
    expect(() => EventSchemas.parse(parseFrame(frame(event)))).not.toThrow();
  }
});

test("the stream terminates on RUN_FINISHED with no [DONE] sentinel", () => {
  const turn = textTurn();
  const terminal = turn.at(-1);
  expect(terminal?.type).toBe(RUN_FINISHED);
  const serialized = turn.map(frame).join("");
  expect(serialized).not.toContain("[DONE]");
});

test("the first-class locale directive and inference-provenance ride along as valid fields (not schema-rejected extras)", () => {
  const started = {
    type: RUN_STARTED,
    threadId: "t",
    runId: "r",
    locale: "fr",
  };
  const finished = {
    type: RUN_FINISHED,
    threadId: "t",
    runId: "r",
    provenance: PROVENANCE_CLOUD,
  };
  // They validate against the real schema (tolerated), AND they are defined
  // fields on the contract's own frame shapes (compile-time), so they are part
  // of the contract, not accidental passthrough.
  const startedParsed = RunStartedEventSchema.parse(started);
  expect(startedParsed.type).toBe(RUN_STARTED);
  expect((startedParsed as { locale?: string }).locale).toBe("fr");
  const finishedParsed = RunFinishedEventSchema.parse(finished);
  expect((finishedParsed as { provenance?: string }).provenance).toBe(
    PROVENANCE_CLOUD
  );
});

test("the pre-emit required-field guard passes every well-formed frame", () => {
  for (const event of [...textTurn(), ...toolTurn()]) {
    expect(missingRequiredFields(event)).toEqual([]);
  }
});

test("the inbound RunAgentInput hand-validator accepts a well-formed body and drops forwardedProps", () => {
  const parsed = parseRunAgentInput({
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    forwardedProps: { adapter: "evil", model: "override" },
  });
  expect(parsed.threadId).toBe("t");
  // forwardedProps is never carried across the seam.
  expect(Object.hasOwn(parsed, "forwardedProps")).toBe(false);
});
