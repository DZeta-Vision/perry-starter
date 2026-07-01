import { expect, test } from "vitest";
import {
  type AgUiFrame,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_START,
} from "../ag-ui-contract";
import { checkSplice } from "../proxy";

// Mutation twin for splice.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts checkSplice's three invariants. This twin proves each one goes
// red on the exact failure it guards: a second RUN_STARTED (run re-opened), a
// second TEXT_MESSAGE_START (a fresh message on failover), and a retracting /
// empty delta (prefix retraction / duplicated tokens at the cut).

test("a re-opened run (second RUN_STARTED) fails the one-run invariant", () => {
  const frames: AgUiFrame[] = [
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "m" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hi" },
    { type: RUN_STARTED, threadId: "t", runId: "r" },
  ];
  expect(checkSplice(frames).oneRunStarted).toBe(false);
});

test("a second TEXT_MESSAGE_START (fresh message on failover) fails the one-start invariant", () => {
  const frames: AgUiFrame[] = [
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "m1" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "The answer " },
    { type: TEXT_MESSAGE_START, messageId: "m2" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "The answer is 42" },
  ];
  expect(checkSplice(frames).oneMessageStart).toBe(false);
});

test("a retracting / empty delta fails the monotonic invariant", () => {
  const frames: AgUiFrame[] = [
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "m" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hello" },
    // An empty delta does not grow the concatenation → not monotonic.
    { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "" },
  ];
  expect(checkSplice(frames).monotonic).toBe(false);
});
