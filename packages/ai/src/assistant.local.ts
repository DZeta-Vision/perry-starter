import type { AgUiFrame, AssistantTurnRequest } from "./ag-ui-contract";
import { PROVENANCE_LOCAL } from "./ag-ui-contract";
import type { AssistantAiSeam } from "./assistant";
import { type EmbeddingResult, stubEmbed } from "./embed";
import { normalizedRunErrorFrame } from "./errors";
import { assembleSystemPrompt } from "./request-assembly";
import { emitAgUiFromDeltas } from "./stream-emit";
import { readOpenAiDeltas } from "./upstream-openai";

// Local-sidecar implementation of the AI seam: the on-device optimization leg.
//
// The daemon supervises a loopback llama-server sidecar; this seam reaches it over
// native fetch (loopback-only, bearer/api-key protected), consumes its
// OpenAI-compatible stream via res.body.getReader(), and hand-emits the pinned
// AG-UI event subset — byte-identical to the cloud leg, so a mid-session re-route
// needs no re-handshake. NO in-process model SDK / WASM / prebuilt-JS enters this
// module; the frames are hand-consumed strings. The account locale is injected
// into the model system context by the ONE shared request-assembly (identical to
// the cloud leg → locale parity). The real GGUF model build is spike-gated; the
// emission state machine here is proven against a controllable stub provider, and
// the cloud floor remains the always-available guarantee regardless.

export interface LocalSeamDeps {
  readonly apiKey?: string;
  // The supervised llama-server loopback base URL (port assigned by the
  // supervisor) and the per-launch bearer it was started with.
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

export const createLocalAssistant = (
  deps: LocalSeamDeps = {}
): AssistantAiSeam => ({
  async *stream(request: AssistantTurnRequest): AsyncGenerator<AgUiFrame> {
    const doFetch = deps.fetch ?? globalThis.fetch;
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    const systemPrompt = assembleSystemPrompt(request);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (deps.apiKey) {
      headers.authorization = `Bearer ${deps.apiKey}`;
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const response = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "local",
          stream: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: request.prompt },
          ],
        }),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`local model unavailable (status ${response.status})`);
      }
      reader = response.body.getReader();
    } catch (error) {
      yield normalizedRunErrorFrame(error);
      return;
    }

    yield* emitAgUiFromDeltas(readOpenAiDeltas(reader), {
      threadId: request.threadId,
      runId: request.runId,
      provenance: PROVENANCE_LOCAL,
    });
  },

  // Compute a document embedding for RAG. Stub (the real model is spike-gated);
  // the projection's single writer calls this and writes the row — the seam never
  // writes the projection table.
  embed(text: string): Promise<EmbeddingResult> {
    return Promise.resolve(stubEmbed(text));
  },
});

export const assistant: AssistantAiSeam = createLocalAssistant();

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "local" as const;
