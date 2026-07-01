import type {
  AgUiFrame,
  AssistantTurnRequest,
  InferenceProvenance,
  LocaleDirective,
} from "./ag-ui-contract";
import {
  PROVENANCE_CLOUD,
  PROVENANCE_LOCAL,
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TEXT_MESSAGE_START,
} from "./ag-ui-contract";
import type { AssistantAiSeam } from "./assistant";
import { normalizedRunErrorFrame } from "./errors";

// The capability/health routing proxy. It normalizes the local llama-server leg
// and the cloud Worker floor to ONE contract and routes by capability probe
// (default route-to-cloud — the local leg is only an optimization over the
// always-available floor) AND liveness AND runtime errors. On a mid-stream local
// fault it splices to the cloud WITHOUT a browser re-handshake: it keeps ONE
// messageId for the turn (no second TEXT_MESSAGE_START, no run re-open) and
// resumes from the partial already shown, appending only growth beyond it
// (prefix-reconcile — monotonic, no retraction, no duplicated tokens at the cut).
// A user cancel is classified distinctly and never re-routes. When BOTH legs are
// unreachable it emits exactly one normalized terminal RUN_ERROR. The locale is
// snapshotted once per turn and injected IDENTICALLY on every leg (the same
// request object), so a failover never switches the answer's language.

export interface AiProxyDeps {
  readonly cloud: AssistantAiSeam;
  readonly local: AssistantAiSeam;
  // Capability probe: true → the device is capable, try local first (cloud is the
  // failover); default false → route straight to the always-available cloud.
  readonly probe?: () => boolean;
}

export interface ProxyTurnInput {
  // Snapshotted once per turn from the write-through active-locale store.
  readonly locale: LocaleDirective;
  readonly prompt: string;
  readonly retrievedContext?: readonly string[];
  readonly runId: string;
  readonly threadId: string;
}

interface Leg {
  readonly locus: InferenceProvenance;
  readonly seam: AssistantAiSeam;
}

// Prefix-reconcile: given the text already shown and a leg's cumulative text,
// return only the growth beyond the shown length (append-only → monotonic, no
// retraction, no duplication at a failover cut).
export const reconcileGrowth = (
  emitted: string,
  legCumulative: string
): string =>
  legCumulative.length > emitted.length
    ? legCumulative.slice(emitted.length)
    : "";

type LegOutcome = "finished" | "errored" | "cancelled";

interface ProxyEmitState {
  emitted: string;
  readonly messageId: string;
}

// Consume ONE leg, emitting reconciled growth under the shared messageId (no
// second TEXT_MESSAGE_START), and report how it ended so the caller can splice,
// finish, or degrade.
async function* consumeLeg(
  leg: Leg,
  request: AssistantTurnRequest,
  signal: AbortSignal | undefined,
  state: ProxyEmitState
): AsyncGenerator<AgUiFrame, LegOutcome> {
  let legCumulative = "";
  try {
    for await (const frame of leg.seam.stream(request)) {
      if (signal?.aborted) {
        return "cancelled";
      }
      if (frame.type === TEXT_MESSAGE_CONTENT) {
        legCumulative += frame.delta;
        const growth = reconcileGrowth(state.emitted, legCumulative);
        if (growth.length > 0) {
          state.emitted += growth;
          yield {
            type: TEXT_MESSAGE_CONTENT,
            messageId: state.messageId,
            delta: growth,
          };
        }
      } else if (frame.type === RUN_FINISHED) {
        return "finished";
      } else if (frame.type === RUN_ERROR) {
        return "errored";
      }
    }
  } catch {
    return "errored";
  }
  return "errored";
}

export const createAiProxy = (deps: AiProxyDeps) => {
  const probe = deps.probe ?? (() => false);
  return {
    async *stream(
      input: ProxyTurnInput,
      signal?: AbortSignal
    ): AsyncGenerator<AgUiFrame> {
      const messageId = `${input.runId}-msg`;
      // ONE request object → both legs get byte-identical locale + context.
      const request: AssistantTurnRequest = {
        threadId: input.threadId,
        runId: input.runId,
        prompt: input.prompt,
        locale: input.locale,
        retrievedContext: input.retrievedContext,
      };
      const order: Leg[] = probe()
        ? [
            { seam: deps.local, locus: PROVENANCE_LOCAL },
            { seam: deps.cloud, locus: PROVENANCE_CLOUD },
          ]
        : [{ seam: deps.cloud, locus: PROVENANCE_CLOUD }];

      // ONE RUN_STARTED + ONE TEXT_MESSAGE_START for the whole turn.
      yield {
        type: RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        locale: input.locale,
      };
      yield { type: TEXT_MESSAGE_START, messageId };

      const state: ProxyEmitState = { emitted: "", messageId };
      let finishedLocus: InferenceProvenance | undefined;
      let succeeded = false;

      for (const leg of order) {
        if (signal?.aborted) {
          return;
        }
        const outcome = yield* consumeLeg(leg, request, signal, state);
        if (outcome === "cancelled") {
          return;
        }
        if (outcome === "finished") {
          finishedLocus = leg.locus;
          succeeded = true;
          break;
        }
        // errored → splice to the next leg under the SAME messageId.
      }

      if (signal?.aborted) {
        return;
      }
      yield { type: TEXT_MESSAGE_END, messageId };
      if (succeeded) {
        yield {
          type: RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          provenance: finishedLocus,
        };
      } else {
        // Both legs unreachable → exactly one normalized terminal error.
        yield normalizedRunErrorFrame(new Error("all AI legs unreachable"));
      }
    },
  };
};

// --- Gate helpers (shared by the conformance gates + their twins) ---

export interface SpliceCheck {
  readonly monotonic: boolean;
  readonly oneMessageStart: boolean;
  readonly oneRunStarted: boolean;
  readonly text: string;
}

// Assert a frame sequence is a valid splice: exactly one RUN_STARTED and one
// TEXT_MESSAGE_START, and the concatenation of content deltas is strictly
// growing (append-only — no retraction, no empty/duplicating delta).
export const checkSplice = (frames: readonly AgUiFrame[]): SpliceCheck => {
  const runStarts = frames.filter((f) => f.type === RUN_STARTED).length;
  const messageStarts = frames.filter(
    (f) => f.type === TEXT_MESSAGE_START
  ).length;
  let accumulator = "";
  let monotonic = true;
  for (const frame of frames) {
    if (frame.type === TEXT_MESSAGE_CONTENT) {
      const next = accumulator + frame.delta;
      if (next.length <= accumulator.length) {
        monotonic = false;
      }
      accumulator = next;
    }
  }
  return {
    oneRunStarted: runStarts === 1,
    oneMessageStart: messageStarts === 1,
    monotonic,
    text: accumulator,
  };
};

// Locale parity: every leg received the same resolved locale as the per-turn
// store snapshot. A leg that defaulted while another read the account value fails.
export const assertLocaleParity = (
  legLocales: readonly string[],
  storeLocale: string
): boolean =>
  legLocales.length > 0 && legLocales.every((locale) => locale === storeLocale);
