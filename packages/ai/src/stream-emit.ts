import type { AgUiFrame, InferenceProvenance } from "./ag-ui-contract";
import {
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TEXT_MESSAGE_START,
} from "./ag-ui-contract";
import { normalizedRunErrorFrame } from "./errors";

export interface TurnMeta {
  // The single messageId the whole turn's text rides under. Defaulted from runId
  // when omitted; passed explicitly by the routing proxy so a mid-session
  // failover keeps ONE messageId across the re-route (the splice).
  readonly messageId?: string;
  readonly provenance?: InferenceProvenance;
  readonly runId: string;
  readonly threadId: string;
}

export const messageIdFor = (meta: TurnMeta): string =>
  meta.messageId ?? `${meta.runId}-msg`;

// Consume an async source of text deltas and yield conformant AG-UI frames:
//   RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* (ONE messageId) →
//   TEXT_MESSAGE_END → RUN_FINISHED.
// On an upstream fault mid-stream, the already-yielded deltas stay valid (no
// retraction) and the turn ends with a normalized terminal RUN_ERROR instead of
// RUN_FINISHED — never leaking provider detail.
export async function* emitAgUiFromDeltas(
  deltas: AsyncIterable<string>,
  meta: TurnMeta
): AsyncGenerator<AgUiFrame> {
  const messageId = messageIdFor(meta);
  yield { type: RUN_STARTED, threadId: meta.threadId, runId: meta.runId };
  yield { type: TEXT_MESSAGE_START, messageId };
  try {
    for await (const delta of deltas) {
      if (delta.length > 0) {
        yield { type: TEXT_MESSAGE_CONTENT, messageId, delta };
      }
    }
  } catch (error) {
    yield { type: TEXT_MESSAGE_END, messageId };
    yield normalizedRunErrorFrame(error);
    return;
  }
  yield { type: TEXT_MESSAGE_END, messageId };
  yield {
    type: RUN_FINISHED,
    threadId: meta.threadId,
    runId: meta.runId,
    provenance: meta.provenance,
  };
}
