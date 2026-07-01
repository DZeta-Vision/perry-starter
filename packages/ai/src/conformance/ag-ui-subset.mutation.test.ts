import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  missingRequiredFields,
  parseRunAgentInput,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
} from "../ag-ui-contract";

// Mutation twin for ag-ui-subset.gate.test.ts — the anti-vacuous proof.
//
// The SAME schema check the gate trusts MUST reject a frame using `toolName`
// instead of `toolCallName`, a TEXT_MESSAGE_CONTENT missing `messageId`, and an
// unknown event type. If any stopped discriminating, the gate would be
// vacuously green and this twin turns red.

test("a TOOL_CALL_START using toolName instead of toolCallName is rejected", () => {
  const bad = { type: "TOOL_CALL_START", toolCallId: "c1", toolName: "search" };
  expect(() => EventSchemas.parse(bad)).toThrow();
});

test("a TEXT_MESSAGE_CONTENT missing messageId is rejected", () => {
  const bad = { type: TEXT_MESSAGE_CONTENT, delta: "hi" };
  expect(() => EventSchemas.parse(bad)).toThrow();
});

test("a TEXT_MESSAGE_CONTENT missing delta is rejected", () => {
  const bad = { type: TEXT_MESSAGE_CONTENT, messageId: "m1" };
  expect(() => EventSchemas.parse(bad)).toThrow();
});

test("an unknown event type is rejected by the discriminated union", () => {
  const bad = { type: "NOT_A_REAL_EVENT", messageId: "m1" };
  expect(() => EventSchemas.parse(bad)).toThrow();
});

test("the pre-emit required-field guard flags a missing required field", () => {
  // A RUN_STARTED without runId, and a TEXT_MESSAGE_CONTENT without delta, are
  // each caught by the contract's own pre-emit guard.
  expect(missingRequiredFields({ type: RUN_STARTED, threadId: "t" })).toContain(
    "runId"
  );
  expect(
    missingRequiredFields({ type: TEXT_MESSAGE_CONTENT, messageId: "m" })
  ).toContain("delta");
  // An event outside the subset is itself invalid.
  expect(missingRequiredFields({ type: "STATE_SNAPSHOT" })).toContain("type");
});

test("the RunAgentInput validator rejects a body missing ids and one with non-array messages", () => {
  expect(() => parseRunAgentInput({ messages: [], tools: [] })).toThrow();
  expect(() =>
    parseRunAgentInput({ threadId: "t", runId: "r", messages: {}, tools: [] })
  ).toThrow();
});
