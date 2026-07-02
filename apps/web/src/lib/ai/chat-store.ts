import type {
  AgUiFrame,
  AssistantTurnRequest,
  InferenceProvenance,
  LocaleDirective,
} from "@perry-starter/ai/contract";
import {
  ASSISTANT_UNAVAILABLE,
  RUN_ERROR,
  RUN_FINISHED,
  TEXT_MESSAGE_CONTENT,
} from "@perry-starter/ai/contract";
import { create } from "zustand";

// The AI chat session store — owned ABOVE the route (a module-level zustand
// store), so navigating away from and back to the panel re-attaches to the same
// in-flight run keyed by a stable threadId. It is the single owner of the chat
// state machine, driven by the pinned AG-UI event subset, and it is DECOUPLED
// from the editor/data path — an AI fault sets error state here and never stalls
// anything else (the AI seam is non-blocking).

export type ChatStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "error"
  | "stopped";

export interface ChatMessage {
  readonly content: string;
  readonly id: string;
  readonly provenance?: InferenceProvenance;
  readonly role: "user" | "assistant";
}

// A leg's frame source for one turn. Production wires this to the daemon/cloud
// SSE endpoint; tests pass a stub that yields canned frames and honors the signal.
export type StreamFactory = (
  request: AssistantTurnRequest,
  signal: AbortSignal
) => AsyncIterable<AgUiFrame>;

export interface ChatSendInput {
  readonly locale: LocaleDirective;
  readonly prompt: string;
  readonly retrievedContext?: readonly string[];
}

export interface ChatState {
  readonly controller: AbortController | null;
  readonly editAssistant: (id: string, content: string) => void;
  readonly errorCode: string | null;
  readonly messages: readonly ChatMessage[];
  readonly reset: () => void;
  readonly runId: string | null;
  readonly send: (
    input: ChatSendInput,
    factory: StreamFactory
  ) => Promise<void>;
  readonly status: ChatStatus;
  readonly stop: () => void;
  readonly threadId: string;
}

type StoreGet = () => ChatState;
type StoreSet = (partial: Partial<ChatState>) => void;

export const isLive = (status: ChatStatus): boolean =>
  status === "thinking" || status === "streaming";

let runCounter = 0;
const nextRunId = (): string => {
  runCounter += 1;
  return `run-${runCounter}`;
};

const newThreadId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `thread-${runCounter}`;

const appendDelta = (
  messages: readonly ChatMessage[],
  id: string,
  delta: string
): ChatMessage[] =>
  messages.map((message) =>
    message.id === id
      ? { ...message, content: message.content + delta }
      : message
  );

// Apply one TEXT_MESSAGE_CONTENT delta; opens the assistant message on the first
// token (thinking → streaming). Returns true once the assistant message exists.
const applyContent = (
  get: StoreGet,
  set: StoreSet,
  assistantId: string,
  delta: string,
  started: boolean
): boolean => {
  if (started) {
    set({ messages: appendDelta(get().messages, assistantId, delta) });
    return true;
  }
  set({
    status: "streaming",
    messages: [
      ...get().messages,
      { id: assistantId, role: "assistant", content: delta },
    ],
  });
  return true;
};

// Settle a completed turn, stamping the honest provenance on the assistant reply.
const applyFinish = (
  get: StoreGet,
  set: StoreSet,
  assistantId: string,
  provenance: InferenceProvenance | undefined
): void => {
  const messages = provenance
    ? get().messages.map((message) =>
        message.id === assistantId ? { ...message, provenance } : message
      )
    : get().messages;
  set({ status: "idle", controller: null, messages });
};

// Terminal states for a loop that ended without RUN_FINISHED: a user cancel
// (aborted) is `stopped` (never a re-route); a clean early end is `idle`.
const settleOpenLoop = (set: StoreSet, aborted: boolean): void => {
  set(
    aborted
      ? { status: "stopped", controller: null }
      : { status: "idle", controller: null }
  );
};

// Settle a thrown fault without re-throwing (non-blocking): a cancel is
// `stopped`, anything else is the normalized error.
const settleFault = (set: StoreSet, aborted: boolean): void => {
  if (aborted) {
    set({ status: "stopped", controller: null });
    return;
  }
  set({ status: "error", controller: null, errorCode: ASSISTANT_UNAVAILABLE });
};

type TurnOutcome = "finished" | "errored" | "open";

// Consume the AG-UI frame stream for one turn, applying each frame to the store.
// Returns how the stream ended so the caller can settle an `open` loop.
const consumeTurn = async (
  frames: AsyncIterable<AgUiFrame>,
  signal: AbortSignal,
  get: StoreGet,
  set: StoreSet,
  assistantId: string
): Promise<TurnOutcome> => {
  let started = false;
  for await (const frame of frames) {
    if (signal.aborted) {
      return "open";
    }
    if (frame.type === TEXT_MESSAGE_CONTENT) {
      started = applyContent(get, set, assistantId, frame.delta, started);
    } else if (frame.type === RUN_FINISHED) {
      applyFinish(get, set, assistantId, frame.provenance);
      return "finished";
    } else if (frame.type === RUN_ERROR) {
      set({
        status: "error",
        controller: null,
        errorCode: frame.code ?? ASSISTANT_UNAVAILABLE,
      });
      return "errored";
    }
  }
  return "open";
};

export const useChatStore = create<ChatState>((set, get) => ({
  threadId: newThreadId(),
  runId: null,
  status: "idle",
  messages: [],
  errorCode: null,
  controller: null,

  send: async (input, factory) => {
    const { threadId } = get();
    const runId = nextRunId();
    const controller = new AbortController();
    const assistantId = `a-${runId}`;

    set({
      status: "thinking",
      runId,
      controller,
      errorCode: null,
      messages: [
        ...get().messages,
        { id: `u-${runId}`, role: "user", content: input.prompt },
      ],
    });

    const request: AssistantTurnRequest = {
      threadId,
      runId,
      prompt: input.prompt,
      locale: input.locale,
      retrievedContext: input.retrievedContext,
    };

    try {
      const outcome = await consumeTurn(
        factory(request, controller.signal),
        controller.signal,
        get,
        set,
        assistantId
      );
      if (outcome === "open") {
        settleOpenLoop(set, controller.signal.aborted);
      }
    } catch {
      // Non-blocking: a fault is classified and NEVER re-thrown to the caller —
      // the editor/data path keeps working.
      settleFault(set, controller.signal.aborted);
    }
  },

  stop: () => {
    get().controller?.abort();
    // Cancel is distinct from a failure; the accumulated partial stays in
    // `messages` (usable/editable) and no re-route is triggered.
    set({ status: "stopped" });
  },

  editAssistant: (id, content) => {
    set({
      messages: get().messages.map((message) =>
        message.id === id ? { ...message, content } : message
      ),
    });
  },

  reset: () => {
    get().controller?.abort();
    set({
      status: "idle",
      runId: null,
      controller: null,
      errorCode: null,
      messages: [],
    });
  },
}));
