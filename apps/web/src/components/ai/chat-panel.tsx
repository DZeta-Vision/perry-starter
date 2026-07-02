import { type FormEvent, useState } from "react";
import { aiErrorText, tAi } from "@/lib/ai/ai-strings";
import { isLive, type StreamFactory, useChatStore } from "@/lib/ai/chat-store";
import { createSseStreamFactory } from "@/lib/ai/sse-stream";
import { useLocaleStore } from "@/lib/locale-store";
import { cn } from "@/lib/utils";

// The AI chat panel. It renders the above-route session store (so navigating away
// and back keeps the in-flight run), streams tokens over SSE, shows a thinking
// indicator before the first token, keeps an always-available stop control while
// the stream is live, announces streaming output via a polite live region, and
// degrades to a calm keyed error line — all without ever blocking the editor.

const defaultStreamFactory = createSseStreamFactory();

export function ChatPanel({
  streamFactory = defaultStreamFactory,
}: {
  readonly streamFactory?: StreamFactory;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const messages = useChatStore((state) => state.messages);
  const status = useChatStore((state) => state.status);
  const errorCode = useChatStore((state) => state.errorCode);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);
  const [draft, setDraft] = useState("");

  const live = isLive(status);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (prompt.length === 0 || live) {
      return;
    }
    setDraft("");
    // send is non-blocking and never rejects (it classifies faults into state);
    // the catch is belt-and-suspenders so the click handler stays sync-safe.
    send({ prompt, locale }, streamFactory).catch(() => undefined);
  };

  return (
    <section
      aria-label={tAi(locale, "ai.chat.title")}
      className="flex flex-col"
    >
      {messages.length === 0 ? (
        <p className="text-muted-foreground">{tAi(locale, "ai.chat.empty")}</p>
      ) : null}

      {/* The conversation log is a polite live region: appended streaming deltas
          are announced without interrupting the user. */}
      <ol
        aria-label={tAi(locale, "ai.chat.liveRegionLabel")}
        aria-live="polite"
        className="flex flex-col gap-2"
      >
        {messages.map((message) => (
          <li data-role={message.role} key={message.id}>
            {message.content}
            {message.role === "assistant" && message.provenance === "cloud" ? (
              <span className="ml-2 text-muted-foreground text-xs">
                {tAi(locale, "ai.provenance.cloud")}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {/* Thinking indicator, before the first token. role=status is itself a
          polite live region, so the wait is announced. */}
      {status === "thinking" ? (
        <p data-testid="ai-thinking" role="status">
          {tAi(locale, "ai.chat.typing")}
        </p>
      ) : null}

      {status === "stopped" ? (
        <p className="text-muted-foreground text-sm">
          {tAi(locale, "ai.chat.stopped")}
        </p>
      ) : null}

      {/* A liveness/runtime failure degrades to a calm keyed line — never a raw
          code, provider name, or alarming toast; the editor keeps working. */}
      {status === "error" ? (
        <p className="text-muted-foreground text-sm" data-testid="ai-error">
          {aiErrorText(locale, errorCode ?? "")}
        </p>
      ) : null}

      <form className="mt-2 flex items-center gap-2" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="ai-chat-input">
          {tAi(locale, "ai.chat.placeholder")}
        </label>
        <input
          className={cn("flex-1 rounded border px-2 py-1")}
          id="ai-chat-input"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={tAi(locale, "ai.chat.placeholder")}
          value={draft}
        />
        <button
          className="rounded bg-primary px-3 py-1 text-primary-foreground"
          disabled={live}
          type="submit"
        >
          {tAi(locale, "ai.chat.send")}
        </button>
        {live ? (
          <button
            className="rounded border px-3 py-1"
            onClick={stop}
            type="button"
          >
            {tAi(locale, "ai.chat.stop")}
          </button>
        ) : null}
      </form>
    </section>
  );
}
