import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import { RUN_STARTED, TEXT_MESSAGE_START } from "../ag-ui-contract";

// Mutation twin for local-leg.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts (1) a normalized error carries no engine-id leak and (2) every
// emitted frame validates against EventSchemas. This twin proves both checks
// discriminate: a frame leaking a GGUF/engine id is flagged, and a
// TEXT_MESSAGE_START missing messageId is rejected.

const LEAK_TOKENS = ["llama", "gguf", "@cf/", "status 5", "at Object."];
const leaks = (value: unknown): boolean => {
  const serialized = JSON.stringify(value).toLowerCase();
  return LEAK_TOKENS.some((token) => serialized.includes(token));
};

test("the leak scan flags a frame that leaked a GGUF/engine id or upstream status", () => {
  const leaky = {
    type: "RUN_ERROR",
    message: "llama.cpp gguf load failed with status 500",
    code: "ASSISTANT_UNAVAILABLE",
  };
  expect(leaks([leaky])).toBe(true);
});

test("the leak scan passes a clean normalized error and a normal turn", () => {
  const clean = [
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: "RUN_ERROR", message: "The assistant is unavailable.", code: "X" },
  ];
  expect(leaks(clean)).toBe(false);
});

test("EventSchemas rejects a TEXT_MESSAGE_START that dropped messageId", () => {
  const dropped = { type: TEXT_MESSAGE_START };
  expect(() => EventSchemas.parse(dropped)).toThrow();
});
