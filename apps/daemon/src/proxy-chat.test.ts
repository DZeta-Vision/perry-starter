import type { AgUiFrame } from "@perry-starter/ai/contract";
import { expect, test } from "vitest";
import type { SseReply } from "./local-chat";
import { createProxyChatHandler } from "./proxy-chat";

const seamOf = (frames: AgUiFrame[]) => ({
  async *stream(): AsyncGenerator<AgUiFrame> {
    for (const frame of frames) {
      await Promise.resolve();
      yield frame;
    }
  },
});

const makeReply = () => {
  const chunks: string[] = [];
  const reply: SseReply = {
    type: () => undefined,
    header: () => undefined,
    raw: {
      write: (chunk: string) => chunks.push(chunk),
      end: () => undefined,
    },
  };
  return { reply, chunks };
};

test("the daemon serves the spliced proxy stream as byte-format AG-UI SSE with one message start and a cloud-provenance finish", async () => {
  const local = seamOf([
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "l", delta: "The answer " },
    { type: "RUN_ERROR", message: "local oom" },
  ]);
  const cloud = seamOf([
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "c", delta: "The answer is 42" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r" },
  ]);
  const handler = createProxyChatHandler({ local, cloud, probe: () => true });
  const { reply, chunks } = makeReply();

  await handler(
    { threadId: "t", runId: "r", prompt: "q", locale: "en" },
    reply
  );

  for (const chunk of chunks) {
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk.endsWith("\n\n")).toBe(true);
  }
  const frames = chunks.map(
    (chunk) =>
      JSON.parse(chunk.slice("data: ".length)) as {
        type: string;
        delta?: string;
        provenance?: string;
      }
  );
  expect(frames.filter((f) => f.type === "TEXT_MESSAGE_START")).toHaveLength(1);
  expect(frames.filter((f) => f.type === "RUN_STARTED")).toHaveLength(1);
  const text = frames
    .filter((f) => f.type === "TEXT_MESSAGE_CONTENT")
    .map((f) => f.delta)
    .join("");
  expect(text).toBe("The answer is 42");
  expect(frames.at(-1)?.type).toBe("RUN_FINISHED");
  expect(frames.at(-1)?.provenance).toBe("cloud");
});
