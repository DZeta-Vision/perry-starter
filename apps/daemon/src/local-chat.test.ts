import { expect, test } from "vitest";
import { createLocalChatHandler, type SseReply } from "./local-chat";

const encoder = new TextEncoder();
const readableFromString = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const OPENAI_STREAM = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}',
  'data: {"choices":[{"delta":{"content":" there"}}]}',
  "data: [DONE]",
].join("\n\n");

const makeReply = () => {
  const chunks: string[] = [];
  let ended = false;
  const reply: SseReply = {
    type: () => undefined,
    header: () => undefined,
    raw: {
      write: (chunk: string) => chunks.push(chunk),
      end: () => {
        ended = true;
      },
    },
  };
  return { reply, chunks, isEnded: () => ended };
};

test("the daemon hand-emits byte-format AG-UI SSE frames from the local sidecar, terminating on RUN_FINISHED", async () => {
  const stubFetch: typeof globalThis.fetch = () =>
    Promise.resolve(new Response(readableFromString(OPENAI_STREAM)));
  const handler = createLocalChatHandler({
    fetch: stubFetch,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
  });
  const { reply, chunks, isEnded } = makeReply();

  await handler(
    { threadId: "t", runId: "r", prompt: "hi", locale: "en" },
    reply
  );

  // Byte format: every chunk is exactly `data: <json>\n\n`.
  for (const chunk of chunks) {
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk.endsWith("\n\n")).toBe(true);
  }
  const frames = chunks.map(
    (chunk) => JSON.parse(chunk.slice("data: ".length)) as { type: string }
  );
  expect(frames[0]?.type).toBe("RUN_STARTED");
  expect(frames.at(-1)?.type).toBe("RUN_FINISHED");
  expect(isEnded()).toBe(true);
});

test("a sidecar failure hand-emits a single normalized RUN_ERROR frame (no leak)", async () => {
  const stubFetch: typeof globalThis.fetch = () =>
    Promise.resolve(new Response("", { status: 503 }));
  const handler = createLocalChatHandler({ fetch: stubFetch });
  const { reply, chunks } = makeReply();

  await handler(
    { threadId: "t", runId: "r", prompt: "hi", locale: "en" },
    reply
  );

  const frames = chunks.map(
    (chunk) => JSON.parse(chunk.slice("data: ".length)) as { type: string }
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]?.type).toBe("RUN_ERROR");
  expect(JSON.stringify(frames).toLowerCase()).not.toContain("status 5");
});
