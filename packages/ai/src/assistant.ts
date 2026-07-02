import type { AgUiFrame, AssistantTurnRequest } from "./ag-ui-contract";
import type { EmbeddingResult } from "./embed";

// The AI seam interface. The contract is identical whether backed by the local
// llama-server sidecar or the cloud Worker AI floor, so the seam compiles for
// every PERRY_TARGET with no application-logic fork. The AI seam is
// read/assist-only by design: it never writes the projection table (single-writer
// rule) — the projection's sole owner CALLS this seam to compute an embedding and
// writes the row itself.
//
// `stream` is the generative surface: given the one normalized turn request
// (locale + retrieved context already assembled), it yields the pinned AG-UI
// event-subset frames. `embed` computes a document's model-tagged embedding for
// RAG — the seam computes it, but never writes the projection. Both target
// implementations satisfy this identical shape.

export interface AssistantAiSeam {
  embed(text: string): Promise<EmbeddingResult>;
  stream(request: AssistantTurnRequest): AsyncIterable<AgUiFrame>;
}
