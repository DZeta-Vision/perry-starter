import type { AssistantTurnRequest, LocaleDirective } from "./ag-ui-contract";
import { DEFAULT_LOCALE } from "./ag-ui-contract";

// The ONE shared request-assembly. Both AI legs (cloud Worker floor, local
// llama-server sidecar) build their model system context from this single
// function so the account locale and the retrieved RAG context are injected
// IDENTICALLY on each leg — a forced mid-stream failover can therefore never
// switch the answer's language (the locale-parity gate).

// Resolve the effective locale for a turn. A pre-auth / no-account turn resolves
// to the default "en"; any non-empty account locale is used verbatim.
export const resolveLocale = (
  accountLocale?: string | null
): LocaleDirective =>
  typeof accountLocale === "string" && accountLocale.length > 0
    ? accountLocale
    : DEFAULT_LOCALE;

// Build the model system prompt. Deterministic in its inputs: the same
// (locale, retrievedContext) always yields the same string, so both legs
// receive byte-identical system context for the same turn.
export const assembleSystemPrompt = (request: AssistantTurnRequest): string => {
  const lines = [
    `You are a helpful assistant. Respond in the user's language (locale: ${request.locale}).`,
  ];
  const context = request.retrievedContext ?? [];
  if (context.length > 0) {
    lines.push(
      "Ground your answer in the following retrieved context from the user's own local documents:"
    );
    for (const passage of context) {
      lines.push(`- ${passage}`);
    }
  }
  return lines.join("\n");
};
