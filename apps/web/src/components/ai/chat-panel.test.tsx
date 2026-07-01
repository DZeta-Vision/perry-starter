import type { AgUiFrame } from "@perry-starter/ai/contract";
import {
  RUN_ERROR,
  RUN_FINISHED,
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
} from "@perry-starter/ai/contract";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { aiErrorText, tAi } from "@/lib/ai/ai-strings";
import { useChatStore } from "@/lib/ai/chat-store";
import { useLocaleStore } from "@/lib/locale-store";
import { ChatPanel } from "./chat-panel";

async function* streamOf(...frames: AgUiFrame[]): AsyncGenerator<AgUiFrame> {
  for (const frame of frames) {
    await Promise.resolve();
    yield frame;
  }
}

const deferred = (): { gate: Promise<void>; release: () => void } => {
  let release: () => void = () => {
    // replaced synchronously below
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

const submit = (prompt: string) => {
  fireEvent.change(screen.getByLabelText(tAi("en", "ai.chat.placeholder")), {
    target: { value: prompt },
  });
  fireEvent.click(
    screen.getByRole("button", { name: tAi("en", "ai.chat.send") })
  );
};

beforeEach(() => {
  useChatStore.getState().reset();
  useLocaleStore.setState({ locale: "en" });
});

test("renders the empty state and the send control with keyed English copy", () => {
  render(<ChatPanel />);
  expect(screen.getByText(tAi("en", "ai.chat.empty"))).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: tAi("en", "ai.chat.send") })
  ).toBeInTheDocument();
});

test("uses the FR catalog when the locale store is French (Lingui-keyed strings)", () => {
  useLocaleStore.setState({ locale: "fr" });
  render(<ChatPanel />);
  expect(
    screen.getByRole("button", { name: tAi("fr", "ai.chat.send") })
  ).toBeInTheDocument();
  expect(screen.getByText(tAi("fr", "ai.chat.empty"))).toBeInTheDocument();
});

test("the conversation log is a polite live region", () => {
  render(<ChatPanel />);
  const log = screen.getByRole("list", {
    name: tAi("en", "ai.chat.liveRegionLabel"),
  });
  expect(log).toHaveAttribute("aria-live", "polite");
});

test("shows a thinking indicator before the first token and an always-available stop while live, then streams", async () => {
  const { gate, release } = deferred();
  async function* gated(): AsyncGenerator<AgUiFrame> {
    yield { type: RUN_STARTED, threadId: "t", runId: "r" };
    await gate;
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hello there" };
    yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
  }
  render(<ChatPanel streamFactory={() => gated()} />);
  submit("hi");

  // Before the first token: the thinking indicator and the stop control show.
  expect(await screen.findByTestId("ai-thinking")).toHaveAttribute(
    "role",
    "status"
  );
  expect(
    screen.getByRole("button", { name: tAi("en", "ai.chat.stop") })
  ).toBeInTheDocument();

  release();
  // After the token: streamed text is in the polite log; thinking is gone.
  expect(await screen.findByText("Hello there")).toBeInTheDocument();
});

test("stop tears the run down to 'stopped' (not error) and keeps the partial, showing the calm stopped line", async () => {
  const { gate, release } = deferred();
  async function* gated(): AsyncGenerator<AgUiFrame> {
    yield { type: RUN_STARTED, threadId: "t", runId: "r" };
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial" };
    await gate;
    yield { type: TEXT_MESSAGE_CONTENT, messageId: "m", delta: " more" };
    yield { type: RUN_FINISHED, threadId: "t", runId: "r" };
  }
  render(<ChatPanel streamFactory={() => gated()} />);
  submit("hi");

  const stopButton = await screen.findByRole("button", {
    name: tAi("en", "ai.chat.stop"),
  });
  fireEvent.click(stopButton);
  release();

  expect(
    await screen.findByText(tAi("en", "ai.chat.stopped"))
  ).toBeInTheDocument();
  // The partial survived and no error surfaced.
  expect(screen.getByText("partial")).toBeInTheDocument();
  expect(screen.queryByTestId("ai-error")).not.toBeInTheDocument();
});

test("a normalized RUN_ERROR renders a calm keyed line, never a raw code", async () => {
  render(
    <ChatPanel
      streamFactory={() =>
        streamOf(
          { type: RUN_STARTED, threadId: "t", runId: "r" },
          {
            type: RUN_ERROR,
            message: "raw upstream",
            code: "ASSISTANT_UNAVAILABLE",
          }
        )
      }
    />
  );
  submit("hi");

  const errorLine = await screen.findByTestId("ai-error");
  expect(errorLine).toHaveTextContent(
    aiErrorText("en", "ASSISTANT_UNAVAILABLE")
  );
  expect(errorLine).not.toHaveTextContent("ASSISTANT_UNAVAILABLE");
  expect(errorLine).not.toHaveTextContent("raw upstream");
});
