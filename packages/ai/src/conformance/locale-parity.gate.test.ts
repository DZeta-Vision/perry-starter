import { expect, test } from "vitest";
import {
  type AgUiFrame,
  type AssistantTurnRequest,
  DEFAULT_LOCALE,
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
} from "../ag-ui-contract";
import type { AssistantAiSeam } from "../assistant";
import { assertLocaleParity, createAiProxy } from "../proxy";
import { assembleSystemPrompt, resolveLocale } from "../request-assembly";

// Conformance gate for locale parity across a mid-stream failover.
//
// Proves the locale snapshotted once per turn is injected IDENTICALLY on both
// legs (never one leg defaulting while the other reads the account value), that a
// forced failover does not switch the answer's language, and that a pre-auth
// turn uses the default "en". The twin proves the parity check goes red on a
// defaulted leg.

// A seam that records the locale of the request it received.
const recordingSeam = (
  frames: AgUiFrame[],
  sink: string[]
): AssistantAiSeam => ({
  async *stream(request: AssistantTurnRequest): AsyncGenerator<AgUiFrame> {
    sink.push(request.locale);
    for (const frame of frames) {
      await Promise.resolve();
      yield frame;
    }
  },
});

const drain = async (source: AsyncIterable<AgUiFrame>): Promise<void> => {
  for await (const _frame of source) {
    // consume
  }
};

test("both legs receive the same account locale across a forced failover; the answer never switches language", async () => {
  const seen: string[] = [];
  const local = recordingSeam(
    [
      { type: RUN_STARTED, threadId: "t", runId: "r" },
      { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Le " },
      { type: RUN_ERROR, message: "local down" },
    ],
    seen
  );
  const cloud = recordingSeam(
    [
      { type: RUN_STARTED, threadId: "t", runId: "r" },
      { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "La réponse" },
      { type: RUN_FINISHED, threadId: "t", runId: "r" },
    ],
    seen
  );

  const proxy = createAiProxy({ local, cloud, probe: () => true });
  await drain(
    proxy.stream({ threadId: "t", runId: "r", prompt: "q", locale: "fr" })
  );

  // Both legs were invoked (failover) and both received the account locale.
  expect(seen).toEqual(["fr", "fr"]);
  expect(assertLocaleParity(seen, "fr")).toBe(true);
  // The same locale yields byte-identical system context on every leg.
  const context = (locale: string) =>
    assembleSystemPrompt({ threadId: "t", runId: "r", prompt: "q", locale });
  expect(context(seen[0] ?? "")).toBe(context(seen[1] ?? ""));
});

test("a pre-auth / no-account turn resolves to the default en", () => {
  expect(resolveLocale()).toBe(DEFAULT_LOCALE);
  expect(assertLocaleParity(["en", "en"], resolveLocale(null))).toBe(true);
});
