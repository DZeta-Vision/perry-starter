import {
  type AiProxyDeps,
  createAiProxy,
  type ProxyTurnInput,
} from "@perry-starter/ai/proxy";
import { resolveLocale } from "@perry-starter/ai/request-assembly";
import { type SseReply, writeAgUiSse } from "./local-chat";

// The daemon's unified chat endpoint handler. It builds the capability/health
// routing proxy over the local sidecar leg + the cloud floor leg and hand-emits
// the spliced, single-messageId AG-UI stream as SSE. The account locale is
// resolved once per turn and injected identically on both legs by the proxy.

interface ProxyChatBody {
  readonly locale?: unknown;
  readonly prompt?: unknown;
  readonly retrievedContext?: unknown;
  readonly runId?: unknown;
  readonly threadId?: unknown;
}

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const createProxyChatHandler = (
  deps: AiProxyDeps
): ((
  body: ProxyChatBody,
  reply: SseReply,
  signal?: AbortSignal
) => Promise<void>) => {
  const proxy = createAiProxy(deps);
  return (body, reply, signal) => {
    const input: ProxyTurnInput = {
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
    return writeAgUiSse(reply, proxy.stream(input, signal));
  };
};
