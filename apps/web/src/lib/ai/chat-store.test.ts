import type { AgUiFrame } from "@perry-starter/ai/contract";
import {
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
} from "@perry-starter/ai/contract";
import { beforeEach, expect, test } from "vitest";
import { isLive, useChatStore } from "./chat-store";

const store = () => useChatStore.getState();
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// Yield a fixed frame list as an async stream (one microtask apart).
async function* streamOf(...frames: AgUiFrame[]): AsyncGenerator<AgUiFrame> {
  for (const frame of frames) {
    await Promise.resolve();
    yield frame;
  }
}

const deferred = (): { gate: Promise<void>; release: () => void } => {
  let release: () => void = () => {
    // replaced synchronously below
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

beforeEach(() => {
  store().reset();
});

test("a full text turn transitions to idle, accumulates one message, and stamps provenance", async () => {
  await store().send({ prompt: "hi", locale: "en" }, () =>
    streamOf(
      { type: RUN_STARTED, threadId: "t", runId: "r" },
      { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hel" },
      { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "lo" },
      { type: RUN_FINISHED, threadId: "t", runId: "r", provenance: "cloud" }
    )
  );
  const state = store();
  expect(state.status).toBe("idle");
  const assistant = state.messages.find((m) => m.role === "assistant");
  expect(assistant?.content).toBe("Hello");
  expect(assistant?.provenance).toBe("cloud");
});

test("status is 'thinking' before the first token, then 'streaming' after it", async () => {
  const { gate, release } = deferred();
  async function* gated(): AsyncGenerator<AgUiFrame> {
    yield { type: RUN_STARTED, threadId: "t", runId: "r" };
    await gate;
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hi" };
    yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
  }
  const pending = store().send({ prompt: "q", locale: "en" }, () => gated());
  await flush();
  expect(store().status).toBe("thinking");
  release();
  await pending;
  expect(store().status).toBe("idle");
});

test("stop after a partial classifies as 'stopped' (not error), retains the editable partial, and drops later deltas", async () => {
  const { gate, release } = deferred();
  async function* partial(): AsyncGenerator<AgUiFrame> {
    yield { type: RUN_STARTED, threadId: "t", runId: "r" };
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial" };
    await gate;
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: " more" };
    yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
  }
  const pending = store().send({ prompt: "q", locale: "en" }, () => partial());
  await flush();
  expect(store().status).toBe("streaming");

  store().stop();
  release();
  await pending;

  const state = store();
  expect(state.status).toBe("stopped");
  const assistant = state.messages.find((m) => m.role === "assistant");
  expect(assistant?.content).toBe("partial");

  if (assistant) {
    store().editAssistant(assistant.id, "edited by user");
  }
  expect(store().messages.find((m) => m.role === "assistant")?.content).toBe(
    "edited by user"
  );
});

test("a RUN_ERROR sets error state with the code and never throws (non-blocking)", async () => {
  await expect(
    store().send({ prompt: "q", locale: "en" }, () =>
      streamOf(
        { type: RUN_STARTED, threadId: "t", runId: "r" },
        { type: RUN_ERROR, message: "raw", code: "ASSISTANT_UNAVAILABLE" }
      )
    )
  ).resolves.toBeUndefined();
  expect(store().status).toBe("error");
  expect(store().errorCode).toBe("ASSISTANT_UNAVAILABLE");
});

test("the session is owned above the route: the threadId is stable and an in-flight run persists across a fresh store read", async () => {
  const threadIdBefore = store().threadId;
  const { gate, release } = deferred();
  async function* gated(): AsyncGenerator<AgUiFrame> {
    yield { type: RUN_STARTED, threadId: "t", runId: "r" };
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "x" };
    await gate;
    yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
  }
  const pending = store().send({ prompt: "q", locale: "en" }, () => gated());
  await flush();

  const reattached = useChatStore.getState();
  expect(reattached.threadId).toBe(threadIdBefore);
  expect(isLive(reattached.status)).toBe(true);
  expect(reattached.messages.some((m) => m.role === "assistant")).toBe(true);

  release();
  await pending;
});
