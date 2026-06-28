import type { AssistantAiSeam, AssistantReply } from "./assistant";

// Cloud-relay implementation of the AI seam. Shape-only stub for now: the
// concrete cloud AI-floor implementation lands later. It satisfies the identical
// interface so the seam compiles for both targets with no fork.
const NOT_IMPLEMENTED =
  "assistant AI seam (cloud-relay) is not implemented yet";

export const assistant = {
  complete(): Promise<AssistantReply> {
    throw new Error(NOT_IMPLEMENTED);
  },
  summarize(): Promise<AssistantReply> {
    throw new Error(NOT_IMPLEMENTED);
  },
} satisfies AssistantAiSeam;

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "cloud" as const;
