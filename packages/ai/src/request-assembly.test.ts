import { expect, test } from "vitest";
import type { AssistantTurnRequest } from "./ag-ui-contract";
import { DEFAULT_LOCALE } from "./ag-ui-contract";
import { assembleSystemPrompt, resolveLocale } from "./request-assembly";

test("resolveLocale defaults a missing/empty account locale to en, else uses it verbatim", () => {
  expect(resolveLocale()).toBe(DEFAULT_LOCALE);
  expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
  expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  expect(resolveLocale("fr")).toBe("fr");
});

test("assembleSystemPrompt injects the locale and is deterministic (both legs get byte-identical context)", () => {
  const request: AssistantTurnRequest = {
    threadId: "t",
    runId: "r",
    prompt: "Explain sync",
    locale: "fr",
  };
  const legA = assembleSystemPrompt(request);
  const legB = assembleSystemPrompt(request);
  // Same turn → byte-identical system context on every leg (locale-parity floor).
  expect(legA).toBe(legB);
  expect(legA).toContain("fr");
});

test("assembleSystemPrompt injects retrieved RAG context when present, omits the block when empty", () => {
  const base = {
    threadId: "t",
    runId: "r",
    prompt: "q",
    locale: "en",
  } as const;
  const withContext = assembleSystemPrompt({
    ...base,
    retrievedContext: ["Doc A says X", "Doc B says Y"],
  });
  expect(withContext).toContain("Doc A says X");
  expect(withContext).toContain("Doc B says Y");

  const withoutContext = assembleSystemPrompt(base);
  expect(withoutContext).not.toContain("retrieved context");
});
