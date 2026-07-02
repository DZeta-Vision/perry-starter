import { expect, test } from "vitest";
import {
  type AgUiFrame,
  ASSISTANT_UNAVAILABLE,
  PROVENANCE_CLOUD,
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
} from "./ag-ui-contract";
import type { StreamingSeam } from "./proxy";
import { createAiProxy, reconcileGrowth } from "./proxy";

const seamOf = (frames: AgUiFrame[]): StreamingSeam => ({
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

const okCloud = seamOf([
  { type: RUN_STARTED, threadId: "t", runId: "r" },
  { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Answer" },
  { type: RUN_FINISHED, threadId: "t", runId: "r" },
]);
const deadLeg = seamOf([
  { type: RUN_STARTED, threadId: "t", runId: "r" },
  { type: RUN_ERROR, message: "down" },
]);

test("reconcileGrowth appends only text beyond the shown length (monotonic, no duplication)", () => {
  expect(reconcileGrowth("The answer ", "The answer is 42")).toBe("is 42");
  expect(reconcileGrowth("abc", "ab")).toBe("");
  expect(reconcileGrowth("abc", "abc")).toBe("");
});

test("by default the proxy routes straight to cloud and stamps provenance:cloud", async () => {
  const proxy = createAiProxy({ local: deadLeg, cloud: okCloud });
  const frames = await collect(
    proxy.stream({ threadId: "t", runId: "r", prompt: "q", locale: "en" })
  );
  expect(frames.at(-1)?.type).toBe(RUN_FINISHED);
  expect((frames.at(-1) as { provenance?: string }).provenance).toBe(
    PROVENANCE_CLOUD
  );
});

test("when both legs are unreachable the proxy emits exactly one normalized terminal RUN_ERROR", async () => {
  const proxy = createAiProxy({
    local: deadLeg,
    cloud: deadLeg,
    probe: () => true,
  });
  const frames = await collect(
    proxy.stream({ threadId: "t", runId: "r", prompt: "q", locale: "en" })
  );
  const errors = frames.filter((f) => f.type === RUN_ERROR);
  expect(errors).toHaveLength(1);
  expect((errors[0] as { code?: string }).code).toBe(ASSISTANT_UNAVAILABLE);
  // No RUN_FINISHED when both are unreachable.
  expect(frames.some((f) => f.type === RUN_FINISHED)).toBe(false);
});

test("a user cancel tears the turn down without re-routing and without an error frame", async () => {
  let release: () => void = () => {
    // replaced below
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const localSpawned: string[] = [];
  const gatedLocal: StreamingSeam = {
    async *stream(): AsyncGenerator<AgUiFrame> {
      localSpawned.push("local");
      yield { type: RUN_STARTED, threadId: "t", runId: "r" };
      yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial" };
      await gate;
      yield { type: RUN_ERROR, message: "would-fail" };
    },
  };
  const cloudProbe: string[] = [];
  const watchedCloud: StreamingSeam = {
    async *stream(): AsyncGenerator<AgUiFrame> {
      cloudProbe.push("cloud");
      await Promise.resolve();
      yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
    },
  };

  const controller = new AbortController();
  const proxy = createAiProxy({
    local: gatedLocal,
    cloud: watchedCloud,
    probe: () => true,
  });
  const pending = collect(
    proxy.stream(
      { threadId: "t", runId: "r", prompt: "q", locale: "en" },
      controller.signal
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  release();
  const frames = await pending;

  // No re-route to cloud, and no terminal error frame (cancel ≠ failure).
  expect(cloudProbe).toEqual([]);
  expect(frames.some((f) => f.type === RUN_ERROR)).toBe(false);
});
