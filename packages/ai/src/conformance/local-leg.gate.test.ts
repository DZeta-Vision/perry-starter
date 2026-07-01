import { EventSchemas } from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  type AgUiFrame,
  ASSISTANT_UNAVAILABLE,
  PROVENANCE_LOCAL,
  RUN_ERROR,
  RUN_FINISHED,
} from "../ag-ui-contract";
import { createLocalAssistant } from "../assistant.local";

// Conformance gate for the on-device local leg.
//
// Proves the local sidecar leg emits the pinned AG-UI subset (validated against
// the real @ag-ui/core@0.0.52 EventSchemas) from an OpenAI-compatible stream,
// stamps provenance:local, reaches the sidecar over loopback WITH the bearer, and
// degrades an upstream failure to a normalized RUN_ERROR carrying no provider
// leak. The emission is proven against a controllable STUB provider (the real
// GGUF build is spike-gated / ship-independent). The twin proves the checks go
// red on a leak or a malformed frame.

const encoder = new TextEncoder();
const readableFromString = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const OPENAI_STREAM = [
  'data: {"choices":[{"delta":{"content":"Bon"}}]}',
  'data: {"choices":[{"delta":{"content":"jour"}}]}',
  "data: [DONE]",
].join("\n\n");

const collect = async (
  source: AsyncIterable<AgUiFrame>
): Promise<AgUiFrame[]> => {
  const frames: AgUiFrame[] = [];
  for await (const frame of source) {
    frames.push(frame);
  }
  return frames;
};

const LEAK_TOKENS = ["llama", "gguf", "@cf/", "status 5", "at Object."];
const leaks = (frames: AgUiFrame[]): boolean => {
  const serialized = JSON.stringify(frames).toLowerCase();
  return LEAK_TOKENS.some((token) => serialized.includes(token));
};

test("the local leg reaches the sidecar over loopback WITH the bearer and emits conformant frames stamped provenance:local", async () => {
  const seen: { url: string; auth: string | null } = { url: "", auth: null };
  const stubFetch: typeof globalThis.fetch = (input, init) => {
    seen.url = String(input);
    const headers = new Headers(init?.headers);
    seen.auth = headers.get("authorization");
    return Promise.resolve(new Response(readableFromString(OPENAI_STREAM)));
  };
  const local = createLocalAssistant({
    fetch: stubFetch,
    baseUrl: "http://127.0.0.1:9999",
    apiKey: "secret-key",
  });
  const frames = await collect(
    local.stream({ threadId: "t", runId: "r", prompt: "hi", locale: "fr" })
  );

  expect(seen.url).toBe("http://127.0.0.1:9999/v1/chat/completions");
  expect(seen.auth).toBe("Bearer secret-key");
  for (const frame of frames) {
    expect(() => EventSchemas.parse(frame)).not.toThrow();
  }
  const terminal = frames.at(-1);
  expect(terminal?.type).toBe(RUN_FINISHED);
  expect((terminal as { provenance?: string }).provenance).toBe(
    PROVENANCE_LOCAL
  );
  expect(leaks(frames)).toBe(false);
});

test("a local sidecar failure degrades to one normalized terminal RUN_ERROR with no engine-id leak", async () => {
  const stubFetch: typeof globalThis.fetch = () =>
    Promise.resolve(new Response("", { status: 500 }));
  const local = createLocalAssistant({ fetch: stubFetch });
  const frames = await collect(
    local.stream({ threadId: "t", runId: "r", prompt: "hi", locale: "en" })
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]?.type).toBe(RUN_ERROR);
  expect((frames[0] as { code?: string }).code).toBe(ASSISTANT_UNAVAILABLE);
  expect(leaks(frames)).toBe(false);
});
