import type { AgUiFrame, AssistantTurnRequest } from "./ag-ui-contract";
import { PROVENANCE_CLOUD, RUN_FINISHED } from "./ag-ui-contract";
import type { AssistantAiSeam } from "./assistant";
import { normalizedRunErrorFrame } from "./errors";
import { readAgUiFrames } from "./upstream-openai";

// Cloud-relay implementation of the AI seam: the always-available cloud AI floor.
//
// INVERTED / OUTBOUND topology: the daemon (or the browser in cloud-relay mode)
// only ever reaches the floor OUTBOUND — there is no inbound edge→device hop. The
// floor Worker host is on the daemon's HTTPS host-pinned egress allowlist
// (`api.perryts.com`); in the daemon, `deps.fetch` is the host-pinned
// `guardedFetch`. The Worker authorizes the request before serving and emits the
// pinned AG-UI event subset; this seam consumes that stream via
// `res.body.getReader()` and re-emits the conformant frames, stamping the honest
// `provenance: cloud` on the terminal RUN_FINISHED. No in-process model SDK is
// used — the frames are hand-consumed over native fetch.

export interface CloudSeamDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly floorUrl?: string;
}

// The cloud floor endpoint on the gatekeeper Worker (egress-allowlisted).
const DEFAULT_FLOOR_URL = "https://api.perryts.com/api/ai/chat";

export const createCloudAssistant = (
  deps: CloudSeamDeps = {}
): AssistantAiSeam => ({
  async *stream(request: AssistantTurnRequest): AsyncGenerator<AgUiFrame> {
    const doFetch = deps.fetch ?? globalThis.fetch;
    const floorUrl = deps.floorUrl ?? DEFAULT_FLOOR_URL;

    // Forward the raw turn fields; the floor Worker assembles the model system
    // context server-side via the ONE shared request-assembly (locale injected
    // identically to the local leg) — the client's system prompt is never trusted.
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const response = await doFetch(floorUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: request.threadId,
          runId: request.runId,
          prompt: request.prompt,
          locale: request.locale,
          retrievedContext: request.retrievedContext ?? [],
        }),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`cloud floor unavailable (status ${response.status})`);
      }
      reader = response.body.getReader();
    } catch (error) {
      // Could not even open the stream → one normalized terminal error, no leak.
      yield normalizedRunErrorFrame(error);
      return;
    }

    for await (const emitted of readAgUiFrames(reader)) {
      if (emitted.type === RUN_FINISHED) {
        yield { ...emitted, provenance: PROVENANCE_CLOUD };
      } else {
        yield emitted;
      }
    }
  },
});

// The default cloud seam (production fetch + default floor URL). Satisfies the
// identical AssistantAiSeam shape as the local target so the seam compiles for
// both PERRY_TARGETs with no fork.
export const assistant: AssistantAiSeam = createCloudAssistant();

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "cloud" as const;
