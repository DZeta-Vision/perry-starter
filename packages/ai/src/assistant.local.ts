import type { AssistantAiSeam, AssistantReply } from "./assistant";

// Local-sidecar implementation of the AI seam. Shape-only stub for now: the
// concrete local llama-server implementation lands later. Method bodies throw
// until then; both targets expose the identical method surface.
const NOT_IMPLEMENTED =
  "assistant AI seam (local-sidecar) is not implemented yet";

export const assistant = {
  complete(): Promise<AssistantReply> {
    throw new Error(NOT_IMPLEMENTED);
  },
  summarize(): Promise<AssistantReply> {
    throw new Error(NOT_IMPLEMENTED);
  },
} satisfies AssistantAiSeam;

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "local" as const;
