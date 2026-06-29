import { describe, expect, test, vi } from "vitest";

// Conformance gate — the daemon egress allowlist blocks non-allowlisted and
// non-HTTPS outbound fetch, and re-validates every redirect hop (so an
// allowlisted host cannot bounce the request off-list). Drives the real
// `guardedFetch` with an INJECTED fetch + audit (no process-wide global stub, so
// the gate cannot race a concurrently scheduled daemon test file):
//   (a) allowlisted host over HTTPS → delegates to the injected fetch (positive);
//   (b) a host NOT on the allowlist → throws AND audits, never fetching;
//   (c) a non-HTTPS scheme to an allowlisted host → throws (scheme check);
//   (d) an allowlisted host that 3xx-redirects OFF-list → blocked + audited;
//   (e) an allowlisted→allowlisted redirect → followed (positive control).

interface GuardedFetchDeps {
  audit?: (host: string) => void;
  fetch?: typeof globalThis.fetch;
}

interface EgressModule {
  auditEgressDenied: (host: string) => void;
  EGRESS_ALLOWLIST: readonly string[];
  guardedFetch: (
    input: string,
    init?: RequestInit,
    deps?: GuardedFetchDeps
  ) => Promise<Response>;
}

const importEgress = async (): Promise<EgressModule> =>
  (await import("../egress-allowlist")) as unknown as EgressModule;

const ok = (): Promise<Response> => Promise.resolve(new Response("ok"));
const redirectTo = (location: string): Promise<Response> =>
  Promise.resolve(new Response(null, { status: 302, headers: { location } }));

describe("the daemon egress allowlist blocks non-allowlisted and non-HTTPS outbound fetch", () => {
  test("an allowlisted host over HTTPS delegates to the injected fetch (anti-vacuous positive)", async () => {
    const mod = await importEgress();
    const allowed = mod.EGRESS_ALLOWLIST[0];
    const fakeFetch = vi.fn(ok);

    await mod.guardedFetch(`https://${allowed}/path`, undefined, {
      fetch: fakeFetch,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  test("a host NOT on the allowlist throws AND audits the host, never fetching", async () => {
    const mod = await importEgress();
    const fakeFetch = vi.fn(ok);
    const audit = vi.fn();

    await expect(
      mod.guardedFetch("https://evil.example.com/exfil", undefined, {
        fetch: fakeFetch,
        audit,
      })
    ).rejects.toThrow();
    expect(audit).toHaveBeenCalledWith("evil.example.com");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("a non-HTTPS scheme to an allowlisted host also throws (the scheme check)", async () => {
    const mod = await importEgress();
    const allowed = mod.EGRESS_ALLOWLIST[0];
    const fakeFetch = vi.fn(ok);

    await expect(
      mod.guardedFetch(`http://${allowed}/path`, undefined, {
        fetch: fakeFetch,
      })
    ).rejects.toThrow();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("an allowlisted host that redirects OFF-list is blocked and the off-list host is audited", async () => {
    const mod = await importEgress();
    const allowed = mod.EGRESS_ALLOWLIST[0];
    const audit = vi.fn();
    const fakeFetch = vi.fn((input: string | URL | Request) =>
      input.toString().includes(allowed)
        ? redirectTo("https://evil.example.com/steal")
        : Promise.resolve(new Response("should-not-reach"))
    );

    await expect(
      mod.guardedFetch(`https://${allowed}/start`, undefined, {
        fetch: fakeFetch,
        audit,
      })
    ).rejects.toThrow();
    expect(audit).toHaveBeenCalledWith("evil.example.com");
  });

  test("an allowlisted host that redirects to ANOTHER allowlisted host is followed (positive control)", async () => {
    const mod = await importEgress();
    const first = mod.EGRESS_ALLOWLIST[0];
    const second = mod.EGRESS_ALLOWLIST[1];
    let call = 0;
    const fakeFetch = vi.fn((input: string | URL | Request) => {
      call += 1;
      if (call === 1 && input.toString().includes(first)) {
        return redirectTo(`https://${second}/next`);
      }
      return Promise.resolve(new Response("final", { status: 200 }));
    });

    const res = await mod.guardedFetch(`https://${first}/start`, undefined, {
      fetch: fakeFetch,
    });
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});
