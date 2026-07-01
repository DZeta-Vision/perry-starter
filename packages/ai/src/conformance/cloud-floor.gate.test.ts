import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  type AgUiFrame,
  ASSISTANT_UNAVAILABLE,
  frame,
  PROVENANCE_CLOUD,
  RUN_ERROR,
  RUN_FINISHED,
  TEXT_MESSAGE_CONTENT,
} from "../ag-ui-contract";
import { createCloudAssistant } from "../assistant.cloud";
import { emitAgUiFromDeltas } from "../stream-emit";
import { readOpenAiDeltas } from "../upstream-openai";

// Conformance gate for the cloud AI floor.
//
// Proves the floor emits/relays the pinned AG-UI subset (validated against the
// real @ag-ui/core@0.0.52 EventSchemas), stamps the honest `provenance: cloud`
// on the terminal RUN_FINISHED, and — on an upstream failure — surfaces exactly
// one normalized terminal RUN_ERROR carrying a stable provider-agnostic code and
// NO provider name / model id / upstream status / stack. Runs in the CI/node tier
// (the only place @ag-ui/core may be imported). Its twin proves these checks go
// red on a leak or a malformed frame.

const encoder = new TextEncoder();
const readableFromString = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

// A stub Worker that streams a canned conformant AG-UI response (no provenance
// yet — the seam stamps it).
const AG_UI_STREAM = [
  { type: "RUN_STARTED", threadId: "t", runId: "r" },
  { type: "TEXT_MESSAGE_START", messageId: "m" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Bonjour" },
  { type: "TEXT_MESSAGE_END", messageId: "m" },
  { type: "RUN_FINISHED", threadId: "t", runId: "r" },
]
  .map((event) => frame(event as AgUiFrame))
  .join("");

const stubFetch =
  (
    body: string,
    init: { ok?: boolean; status?: number } = {}
  ): typeof globalThis.fetch =>
  () =>
    Promise.resolve(
      new Response(readableFromString(body), {
        status: init.status ?? 200,
      })
    );

const collect = async (
  source: AsyncIterable<AgUiFrame>
): Promise<AgUiFrame[]> => {
  const frames: AgUiFrame[] = [];
  for await (const f of source) {
    frames.push(f);
  }
  return frames;
};

// The forbidden tokens a normalized error must never carry.
const LEAK_TOKENS = [
  "@cf/",
  "workers-ai",
  "status 5",
  "status 4",
  "at Object.",
  "llama",
  "gpt-",
];
const leaks = (frames: AgUiFrame[]): boolean => {
  const serialized = JSON.stringify(frames).toLowerCase();
  return LEAK_TOKENS.some((token) => serialized.includes(token.toLowerCase()));
};

test("the cloud floor relays conformant AG-UI frames and stamps provenance:cloud on RUN_FINISHED", async () => {
  const cloud = createCloudAssistant({ fetch: stubFetch(AG_UI_STREAM) });
  const frames = await collect(
    cloud.stream({ threadId: "t", runId: "r", prompt: "hi", locale: "fr" })
  );

  for (const f of frames) {
    expect(() => EventSchemas.parse(f)).not.toThrow();
  }
  const terminal = frames.at(-1);
  expect(terminal?.type).toBe(RUN_FINISHED);
  expect((terminal as { provenance?: string }).provenance).toBe(
    PROVENANCE_CLOUD
  );
  expect(leaks(frames)).toBe(false);
});

test("emitAgUiFromDeltas turns OpenAI-compat deltas into one-messageId conformant frames", async () => {
  const openAiSse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "data: [DONE]",
  ].join("\n\n");
  const reader = readableFromString(openAiSse).getReader();
  const frames = await collect(
    emitAgUiFromDeltas(readOpenAiDeltas(reader), {
      threadId: "t",
      runId: "r",
      provenance: PROVENANCE_CLOUD,
    })
  );
  for (const f of frames) {
    expect(() => EventSchemas.parse(f)).not.toThrow();
  }
  // Exactly one messageId across all TEXT_MESSAGE_CONTENT frames.
  const ids = new Set(
    frames
      .filter((f) => f.type === TEXT_MESSAGE_CONTENT)
      .map((f) => (f as { messageId: string }).messageId)
  );
  expect(ids.size).toBe(1);
  expect(frames.at(-1)?.type).toBe(RUN_FINISHED);
});

test("an upstream open failure yields exactly one normalized terminal RUN_ERROR with no leak", async () => {
  const cloud = createCloudAssistant({
    fetch: stubFetch("", { status: 503 }),
  });
  const frames = await collect(
    cloud.stream({ threadId: "t", runId: "r", prompt: "hi", locale: "en" })
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]?.type).toBe(RUN_ERROR);
  expect((frames[0] as { code?: string }).code).toBe(ASSISTANT_UNAVAILABLE);
  expect(leaks(frames)).toBe(false);
  expect(() => EventSchemas.parse(frames[0])).not.toThrow();
});

test("an in-band mid-stream upstream error degrades to a normalized RUN_ERROR after valid partial deltas", async () => {
  const openAiSse = [
    'data: {"choices":[{"delta":{"content":"partial"}}]}',
    'data: {"error":{"message":"cf status 500 llama oom"}}',
  ].join("\n\n");
  const reader = readableFromString(openAiSse).getReader();
  const frames = await collect(
    emitAgUiFromDeltas(readOpenAiDeltas(reader), { threadId: "t", runId: "r" })
  );
  // The partial content survived (no retraction) and the turn ends on RUN_ERROR.
  expect(frames.some((f) => f.type === TEXT_MESSAGE_CONTENT)).toBe(true);
  expect(frames.at(-1)?.type).toBe(RUN_ERROR);
  // The upstream detail ("cf status 500 llama oom") never reaches the wire.
  expect(leaks(frames)).toBe(false);
});
