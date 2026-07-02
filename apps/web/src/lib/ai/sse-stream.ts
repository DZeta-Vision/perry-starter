import type {
  AgUiFrame,
  AssistantTurnRequest,
} from "@perry-starter/ai/contract";
import { readAgUiFrames } from "@perry-starter/ai/upstream-openai";
import type { StreamFactory } from "./chat-store";

// The production stream factory: consume the same-origin chat SSE endpoint (the
// daemon proxy on desktop, the Worker-backed API in the cloud-relay PWA — one
// byte-identical AG-UI contract) via the tested frame reader. The AbortSignal is
// threaded into `fetch`, so a user stop tears down the upstream request AND the
// body stream (the Worker actually stops), not just the local render.

// Same-origin endpoint; the daemon/Worker serves the pinned AG-UI subset here.
const DEFAULT_CHAT_ENDPOINT = "/api/chat";

export const createSseStreamFactory = (
  endpoint: string = DEFAULT_CHAT_ENDPOINT
): StreamFactory =>
  async function* stream(
    request: AssistantTurnRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgUiFrame> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: request.threadId,
        runId: request.runId,
        prompt: request.prompt,
        locale: request.locale,
        retrievedContext: request.retrievedContext ?? [],
      }),
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`chat endpoint unavailable (status ${response.status})`);
    }
    yield* readAgUiFrames(response.body.getReader());
  };
