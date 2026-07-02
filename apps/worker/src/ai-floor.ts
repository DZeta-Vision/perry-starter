import {
  type AgUiFrame,
  frame,
  PROVENANCE_CLOUD,
} from "@perry-starter/ai/contract";
import { normalizedRunErrorFrame } from "@perry-starter/ai/errors";
import {
  assembleSystemPrompt,
  resolveLocale,
} from "@perry-starter/ai/request-assembly";
import { emitAgUiFromDeltas } from "@perry-starter/ai/stream-emit";
import { readOpenAiDeltas } from "@perry-starter/ai/upstream-openai";
import { auth } from "@perry-starter/auth";

// The cloud Worker AI floor — the always-available inference path (when the
// device has edge connectivity), reached by the daemon/browser OUTBOUND only
// (inverted topology). It authorizes before serving, assembles the model system
// context via the ONE shared request-assembly (account locale injected
// identically to the local leg), runs Workers AI, and hand-emits the pinned
// AG-UI event subset — byte-identical to the local leg, so a mid-session
// re-route across legs needs no client re-handshake. An upstream failure becomes
// a normalized terminal RUN_ERROR (stable code, no provider id/status/stack).

// The Workers-AI text model is a config knob (default a standard Workers-AI text
// model), overridable per deployment; it stays server-side and never reaches the
// wire.
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface WorkersAiBinding {
  run(
    model: string,
    options: {
      messages: { role: string; content: string }[];
      stream: true;
    }
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface AiFloorEnv {
  readonly AI: WorkersAiBinding;
  readonly AI_TEXT_MODEL?: string;
}

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  // Defeat proxy/CDN buffering of the event stream on the cloud path.
  "x-accel-buffering": "no",
};

interface FloorBody {
  readonly locale?: unknown;
  readonly prompt?: unknown;
  readonly retrievedContext?: unknown;
  readonly runId?: unknown;
  readonly threadId?: unknown;
}

const encoder = new TextEncoder();

const oneFrameSse = (single: AgUiFrame): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame(single)));
      controller.close();
    },
  });

const framesToSse = (
  frames: AsyncIterable<AgUiFrame>
): ReadableStream<Uint8Array> => {
  const iterator = frames[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frame(value)));
    },
  });
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const handleAiFloor = async (
  request: Request,
  env: AiFloorEnv
): Promise<Response> => {
  // The Worker AUTHORIZES before serving (the gatekeeper); no session, no floor.
  const session = await auth.api.getSession({ headers: request.headers });
  if (session === null) {
    return new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const body = (await request.json().catch(() => ({}))) as FloorBody;
  const threadId = asString(body.threadId);
  const runId = asString(body.runId);
  const prompt = asString(body.prompt);
  const locale = resolveLocale(asString(body.locale));
  const retrievedContext = Array.isArray(body.retrievedContext)
    ? body.retrievedContext.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  // ONE shared request-assembly — identical to the local leg (locale parity).
  const systemPrompt = assembleSystemPrompt({
    threadId,
    runId,
    prompt,
    locale,
    retrievedContext,
  });
  const model = env.AI_TEXT_MODEL ?? DEFAULT_TEXT_MODEL;

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: true,
    });
  } catch (error) {
    return new Response(oneFrameSse(normalizedRunErrorFrame(error)), {
      headers: SSE_HEADERS,
    });
  }

  const agui = emitAgUiFromDeltas(readOpenAiDeltas(upstream.getReader()), {
    threadId,
    runId,
    provenance: PROVENANCE_CLOUD,
  });
  return new Response(framesToSse(agui), { headers: SSE_HEADERS });
};

// The path the cloud AI floor is served at (same-origin on the gatekeeper Worker).
export const AI_FLOOR_PATH = "/api/ai/chat";
