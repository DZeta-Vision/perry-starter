// The AI seam interface — shape-only for now (concrete implementations land
// later). The contract is identical whether backed by a local sidecar or a
// cloud endpoint. The AI seam is read/assist-only by design: it never writes the
// projection table (single-writer rule).

export interface AssistantPrompt {
  readonly content: string;
  readonly threadId: string;
}

export interface AssistantReply {
  readonly content: string;
  readonly threadId: string;
}

// The uniform AI seam. Both target implementations satisfy this identical shape
// so the seam compiles for every target with no application-logic fork.
export interface AssistantAiSeam {
  complete(prompt: AssistantPrompt): Promise<AssistantReply>;
  summarize(prompt: AssistantPrompt): Promise<AssistantReply>;
}
