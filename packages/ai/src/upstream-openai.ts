import type { AgUiFrame } from "./ag-ui-contract";

// Consumers for the two upstream stream shapes this AI surface reads, both via
// the native `res.body.getReader()` + `reader.read()` loop (never a feature-detect
// of `getReader`, which is `undefined` on the Perry daemon even though `read()`
// works).

const DATA_PREFIX = "data:";
const DONE_SENTINEL = "[DONE]";

interface OpenAiChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string };
  }[];
  readonly error?: unknown;
}

// Split off the lines that are fully received. While streaming, only content
// before the last newline is complete; once the stream ends, the whole buffer is
// complete so the final unterminated line is flushed (never dropped).
const readyLines = (
  buffer: string,
  ended: boolean
): { lines: string[]; rest: string } => {
  const cut = ended ? buffer.length : buffer.lastIndexOf("\n") + 1;
  return { lines: buffer.slice(0, cut).split("\n"), rest: buffer.slice(cut) };
};

// Consume an OpenAI-compatible streaming response body (SSE `data: {json}\n\n`,
// terminal `data: [DONE]`) and yield the text deltas. Handles the mid-stream
// IN-BAND error convention (a `data: {"error":…}` frame arriving at HTTP 200 —
// the llama.cpp / OpenAI-compat behavior) by THROWING so the caller emits a
// normalized terminal RUN_ERROR. Used by the cloud Worker floor and the local
// llama-server leg to consume the raw model stream.
export async function* readOpenAiDeltas(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  while (!ended) {
    const result = await reader.read();
    ended = result.done;
    if (result.value) {
      buffer += decoder.decode(result.value, { stream: true });
    }
    const { lines, rest } = readyLines(buffer, ended);
    buffer = rest;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith(DATA_PREFIX)) {
        continue;
      }
      const payload = line.slice(DATA_PREFIX.length).trim();
      if (payload === DONE_SENTINEL) {
        return;
      }
      const chunk = JSON.parse(payload) as OpenAiChunk;
      if (chunk.error !== undefined) {
        throw new Error("upstream in-band stream error");
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield delta;
      }
    }
  }
}

// Consume an already-conformant AG-UI SSE stream (`data: {frame}\n\n`) and yield
// the parsed frame objects. Used by the cloud seam and the routing proxy to
// consume a Worker-emitted or leg-emitted AG-UI stream over the wire.
export async function* readAgUiFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<AgUiFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  while (!ended) {
    const result = await reader.read();
    ended = result.done;
    if (result.value) {
      buffer += decoder.decode(result.value, { stream: true });
    }
    const { lines, rest } = readyLines(buffer, ended);
    buffer = rest;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0 || !line.startsWith(DATA_PREFIX)) {
        continue;
      }
      const payload = line.slice(DATA_PREFIX.length).trim();
      if (payload === DONE_SENTINEL) {
        return;
      }
      yield JSON.parse(payload) as AgUiFrame;
    }
  }
}

// Synchronous parse of a whole AG-UI SSE text buffer into its frames (test /
// non-streaming helper).
export const parseAgUiStreamText = (text: string): AgUiFrame[] => {
  const frames: AgUiFrame[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || !line.startsWith(DATA_PREFIX)) {
      continue;
    }
    const payload = line.slice(DATA_PREFIX.length).trim();
    if (payload === DONE_SENTINEL) {
      break;
    }
    frames.push(JSON.parse(payload) as AgUiFrame);
  }
  return frames;
};
