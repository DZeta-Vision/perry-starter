import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import { RUN_ERROR, TEXT_MESSAGE_CONTENT } from "../ag-ui-contract";

// Mutation twin for cloud-floor.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts two checks: (1) a normalized error carries NO provider
// leak, and (2) every emitted frame validates against EventSchemas. This twin
// proves BOTH checks genuinely discriminate: a frame that DOES leak a provider
// token is flagged, and a re-frame that dropped `messageId` is rejected.

const LEAK_TOKENS = [
  "@cf/",
  "workers-ai",
  "status 5",
  "status 4",
  "at Object.",
  "llama",
  "gpt-",
];
const leaks = (value: unknown): boolean => {
  const serialized = JSON.stringify(value).toLowerCase();
  return LEAK_TOKENS.some((token) => serialized.includes(token.toLowerCase()));
};

test("the leak scan flags a RUN_ERROR that leaked a provider id / upstream status / stack", () => {
  const leaky = {
    type: RUN_ERROR,
    message:
      "Workers-AI model @cf/meta/llama returned status 500\n at Object.run",
    code: "ASSISTANT_UNAVAILABLE",
  };
  // If the scan stopped discriminating, this would be false and the gate's
  // no-leak assertion would be vacuous.
  expect(leaks([leaky])).toBe(true);
});

test("the leak scan passes a clean normalized error", () => {
  const clean = {
    type: RUN_ERROR,
    message: "The assistant is unavailable.",
    code: "ASSISTANT_UNAVAILABLE",
  };
  expect(leaks([clean])).toBe(false);
});

test("EventSchemas rejects a TEXT_MESSAGE_CONTENT frame that dropped messageId", () => {
  const dropped = { type: TEXT_MESSAGE_CONTENT, delta: "hi" };
  expect(() => EventSchemas.parse(dropped)).toThrow();
});
