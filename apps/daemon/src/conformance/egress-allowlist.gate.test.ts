import { afterEach, describe, expect, test, vi } from "vitest";

// Conformance gate — the daemon egress allowlist blocks non-allowlisted and
// non-HTTPS outbound fetch (so a compromised dependency cannot exfiltrate).
// Unit-tests the `guardedFetch` wrapper with the inner native fetch mocked:
//   (a) an allowlisted host over HTTPS → delegates to native fetch (positive);
//   (b) a host NOT on the allowlist → throws AND audits (auditEgressDenied);
//   (c) a non-HTTPS scheme to an allowlisted host → also throws (scheme check).
//
// The runtime `guardedFetch` is the leg gated here. The mutation twin proves an
// unconditional delegate, an empty/`*` allowlist, and a removed scheme check
// each redden.

interface EgressModule {
  auditEgressDenied: (host: string) => void;
  EGRESS_ALLOWLIST: readonly string[];
  guardedFetch: (input: string, init?: RequestInit) => Promise<unknown>;
}

const importEgress = async (): Promise<EgressModule> =>
  (await import("../egress-allowlist")) as unknown as EgressModule;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the daemon egress allowlist blocks non-allowlisted and non-HTTPS outbound fetch", () => {
  test("an allowlisted host over HTTPS delegates to native fetch (anti-vacuous positive)", async () => {
    const mod = await importEgress();
    const allowed = mod.EGRESS_ALLOWLIST[0];
    const nativeFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await mod.guardedFetch(`https://${allowed}/path`);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  test("a host NOT on the allowlist throws AND audits (auditEgressDenied invoked)", async () => {
    const mod = await importEgress();
    const nativeFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    const auditSpy = vi.spyOn(mod, "auditEgressDenied");

    await expect(
      mod.guardedFetch("https://evil.example.com/exfil")
    ).rejects.toThrow();
    expect(auditSpy).toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  test("a non-HTTPS scheme to an allowlisted host also throws (the scheme check)", async () => {
    const mod = await importEgress();
    const allowed = mod.EGRESS_ALLOWLIST[0];
    const nativeFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await expect(mod.guardedFetch(`http://${allowed}/path`)).rejects.toThrow();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
