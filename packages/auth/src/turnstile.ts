// Cloudflare Turnstile SERVER-SIDE siteverify — the CAPTCHA is a GATE, never the
// throttle (the strongly-consistent DO counter remains the authoritative throttle).
//
// The browser only collects the `cf-turnstile-response` token; the SERVER (the
// cloud Worker) verifies it by POSTing `{ secret, response, remoteip }` to
// Cloudflare's siteverify host and gating on the SERVER's `{ success }` verdict. A
// browser-asserted "success" is NEVER trusted — a `{ success: false }` server
// response is rejected regardless of what the client claims. `fetch` is injected
// (default the global) so the POST target, body, and verdict-gating are provable
// deterministically without a network, and a network/parse failure is treated as a
// FAILED verification (fail-closed), never a pass.

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyInput {
  readonly remoteip: string;
  readonly secret: string;
  readonly token: string;
}

export interface TurnstileVerifyResult {
  readonly success: boolean;
}

export interface TurnstileVerifyDeps {
  // Injected so tests can capture the POST target/body and drive the server
  // verdict; defaults to the runtime global `fetch` on both Worker and Node.
  readonly fetch?: typeof fetch;
}

export const verifyTurnstileToken = async (
  input: TurnstileVerifyInput,
  deps: TurnstileVerifyDeps = {}
): Promise<TurnstileVerifyResult> => {
  const doFetch = deps.fetch ?? fetch;
  // The exact siteverify contract: secret + the collected response token +
  // remoteip, form-encoded.
  const body = new URLSearchParams({
    remoteip: input.remoteip,
    response: input.token,
    secret: input.secret,
  });
  try {
    const res = await doFetch(TURNSTILE_SITEVERIFY_URL, {
      body,
      method: "POST",
    });
    const data = (await res.json()) as { success?: unknown };
    // Gate ONLY on the server's boolean verdict — never a client assertion.
    return { success: data.success === true };
  } catch {
    // Fail-closed: an unreachable/garbled siteverify is a failed verification.
    return { success: false };
  }
};
