import { expect, test } from "vitest";
import { frame, RUN_FINISHED, RUN_STARTED } from "./ag-ui-contract";
import {
  parseAgUiStreamText,
  readAgUiFrames,
  readOpenAiDeltas,
} from "./upstream-openai";

const encoder = new TextEncoder();
const readerFor = (text: string): ReadableStreamDefaultReader<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }).getReader();

const drain = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
};

test("readOpenAiDeltas extracts content deltas and stops at [DONE]", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "data: [DONE]",
    'data: {"choices":[{"delta":{"content":"IGNORED"}}]}',
  ].join("\n\n");
  const deltas = await drain(readOpenAiDeltas(readerFor(sse)));
  expect(deltas).toEqual(["Hel", "lo"]);
});

test("readOpenAiDeltas throws on an in-band error frame (HTTP-200 error convention)", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"x"}}]}',
    'data: {"error":{"message":"oom"}}',
  ].join("\n\n");
  await expect(drain(readOpenAiDeltas(readerFor(sse)))).rejects.toThrow();
});

test("readAgUiFrames round-trips serialized AG-UI frames back to objects", async () => {
  const serialized =
    frame({ type: RUN_STARTED, threadId: "t", runId: "r" }) +
    frame({ type: RUN_FINISHED, threadId: "t", runId: "r" });
  const frames = await drain(readAgUiFrames(readerFor(serialized)));
  expect(frames.map((f) => f.type)).toEqual([RUN_STARTED, RUN_FINISHED]);
});

test("parseAgUiStreamText parses a whole buffer and stops at [DONE]", () => {
  const text = `${frame({ type: RUN_STARTED, threadId: "t", runId: "r" })}data: [DONE]\n\n`;
  const frames = parseAgUiStreamText(text);
  expect(frames).toHaveLength(1);
  expect(frames[0]?.type).toBe(RUN_STARTED);
});
