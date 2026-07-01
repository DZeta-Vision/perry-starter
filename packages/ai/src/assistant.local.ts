import type { AgUiFrame, AssistantTurnRequest } from "./ag-ui-contract";
import type { AssistantAiSeam } from "./assistant";
import { normalizedRunErrorFrame } from "./errors";

// Local-sidecar implementation of the AI seam. The concrete llama-server leg
// (spawn the loopback sidecar, consume its OpenAI-compatible stream via native
// fetch, hand-emit the AG-UI subset) lands later; until then this exposes
// the identical `stream` shape so the seam compiles for both targets, and it
// degrades honestly to the normalized terminal error rather than throwing. No
// in-process model SDK/WASM enters this module.

export const createLocalAssistant = (): AssistantAiSeam => ({
  // biome-ignore lint/suspicious/useAwait: placeholder generator; the real local leg awaits reader.read().
  async *stream(_request: AssistantTurnRequest): AsyncGenerator<AgUiFrame> {
    yield normalizedRunErrorFrame(
      new Error("local llama-server leg not wired")
    );
  },
});

export const assistant: AssistantAiSeam = createLocalAssistant();

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "local" as const;
