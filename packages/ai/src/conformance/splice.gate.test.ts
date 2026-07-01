import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  type AgUiFrame,
  PROVENANCE_CLOUD,
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_START,
} from "../ag-ui-contract";
import type { AssistantAiSeam } from "../assistant";
import { checkSplice, createAiProxy } from "../proxy";

// Conformance gate for the mid-session failover splice.
//
// Proves that a forced mid-stream local fault splices to the cloud under ONE
// messageId with NO second TEXT_MESSAGE_START and NO run re-open, and that the
// concatenation of emitted TEXT_MESSAGE_CONTENT deltas is monotonically growing
// (no prefix retraction, no duplicated tokens at the cut). The twin proves the
// check goes red on a second start / a re-opened run / a retracting delta.

const seamOf = (frames: AgUiFrame[]): AssistantAiSeam => ({
  async *stream(): AsyncGenerator<AgUiFrame> {
    for (const frame of frames) {
      await Promise.resolve();
      yield frame;
    }
  },
});

const collect = async (
  source: AsyncIterable<AgUiFrame>
): Promise<AgUiFrame[]> => {
  const out: AgUiFrame[] = [];
  for await (const frame of source) {
    out.push(frame);
  }
  return out;
};

test("a forced mid-stream local fault splices to cloud under one messageId, monotonically, and stamps provenance:cloud", async () => {
  const local = seamOf([
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "local-m" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "local-m", delta: "The answer " },
    { type: RUN_ERROR, message: "local oom" },
  ]);
  const cloud = seamOf([
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "cloud-m" },
    {
      type: TEXT_MESSAGE_CONTENT,
      messageId: "cloud-m",
      delta: "The answer is 42",
    },
    { type: RUN_FINISHED, threadId: "t", runId: "r" },
  ]);

  const proxy = createAiProxy({ local, cloud, probe: () => true });
  const frames = await collect(
    proxy.stream({ threadId: "t", runId: "r", prompt: "q", locale: "en" })
  );

  for (const frame of frames) {
    expect(() => EventSchemas.parse(frame)).not.toThrow();
  }

  const splice = checkSplice(frames);
  expect(splice.oneRunStarted).toBe(true);
  expect(splice.oneMessageStart).toBe(true);
  expect(splice.monotonic).toBe(true);
  // The shown text grew from the local partial into the cloud completion with no
  // duplication at the cut.
  expect(splice.text).toBe("The answer is 42");

  // Exactly one messageId across all forwarded content frames.
  const ids = new Set(
    frames
      .filter((f) => f.type === TEXT_MESSAGE_CONTENT)
      .map((f) => (f as { messageId: string }).messageId)
  );
  expect(ids.size).toBe(1);

  const terminal = frames.at(-1);
  expect(terminal?.type).toBe(RUN_FINISHED);
  expect((terminal as { provenance?: string }).provenance).toBe(
    PROVENANCE_CLOUD
  );
});

test("checkSplice accepts a clean single-leg turn (the check is not always-red)", () => {
  const clean: AgUiFrame[] = [
    { type: RUN_STARTED, threadId: "t", runId: "r" },
    { type: TEXT_MESSAGE_START, messageId: "m" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hello" },
    { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: " world" },
    { type: RUN_FINISHED, threadId: "t", runId: "r" },
  ];
  const result = checkSplice(clean);
  expect(result.oneRunStarted).toBe(true);
  expect(result.oneMessageStart).toBe(true);
  expect(result.monotonic).toBe(true);
});
