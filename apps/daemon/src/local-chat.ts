import {
  createLocalAssistant,
  type LocalSeamDeps,
} from "@perry-starter/ai/assistant.local";
import {
  type AgUiFrame,
  type AssistantTurnRequest,
  frame,
} from "@perry-starter/ai/contract";
import { resolveLocale } from "@perry-starter/ai/request-assembly";

// The daemon's local-leg SSE emitter. It consumes the on-device sidecar's
// OpenAI-compatible stream (inside the local seam) and HAND-EMITS the pinned
// AG-UI event subset as `data: <json>\n\n` frames over the daemon's HTTP host,
// terminating on RUN_FINISHED — byte-identical to the cloud leg. Content-type is
// set with `reply.type(...)` (never the header setter, which the daemon's fastify
// ignores for content-type). No in-process model SDK enters the daemon.

// A minimal structural reply — the real FastifyReply satisfies it; a test double
// can too, so the byte-format is provable without booting the HTTP host.
export interface SseReply {
  header(name: string, value: string): unknown;
  readonly raw: {
    write(chunk: string): unknown;
    end(): unknown;
  };
  type(contentType: string): unknown;
}

export const writeAgUiSse = async (
  reply: SseReply,
  frames: AsyncIterable<AgUiFrame>
): Promise<void> => {
  reply.type("text/event-stream");
  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");
  for await (const event of frames) {
    reply.raw.write(frame(event));
  }
  reply.raw.end();
};

interface LocalChatBody {
  readonly locale?: unknown;
  readonly prompt?: unknown;
  readonly retrievedContext?: unknown;
  readonly runId?: unknown;
  readonly threadId?: unknown;
}

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Build the local-leg chat handler bound to the supervised sidecar (base URL +
// bearer arrive via `deps`). Returns an async handler that hand-emits AG-UI SSE.
export const createLocalChatHandler = (
  deps: LocalSeamDeps
): ((body: LocalChatBody, reply: SseReply) => Promise<void>) => {
  const local = createLocalAssistant(deps);
  return (body, reply) => {
    const turn: AssistantTurnRequest = {
      threadId: asString(body.threadId),
      runId: asString(body.runId),
      prompt: asString(body.prompt),
      locale: resolveLocale(asString(body.locale)),
      retrievedContext: Array.isArray(body.retrievedContext)
        ? body.retrievedContext.filter(
            (item): item is string => typeof item === "string"
          )
        : undefined,
    };
    return writeAgUiSse(reply, local.stream(turn));
  };
};
