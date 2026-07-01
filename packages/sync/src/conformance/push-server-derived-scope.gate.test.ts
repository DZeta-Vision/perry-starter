import { describe, expect, test } from "vitest";
import type { UnackedDelta } from "../index";
import { MissingEnforcedScopeError, pushDeltaBatch } from "../push";
import type { DeltaLogTransport, TransportRow } from "../transport";

// Conformance gate — the delta-log push is fail-CLOSED on the cross-scope
// perimeter. Two invariants, each twinned in the paired mutation file:
//   1. Every pushed row is stamped with the SERVER-DERIVED enforced scope; the
//      client-supplied scope_user_id (which a forged request controls) never
//      reaches the wire as the row's scope.
//   2. A push with no enforced scope is REJECTED outright — there is no fallback
//      to the client scope, so a caller that forgets to inject the derived scope
//      writes nothing rather than stamping a client-chosen owner.

const ENFORCED_SCOPE = "scope-server-derived-owner";
const CLIENT_FORGED_SCOPE = "scope-client-forged-other";
const VALID_ULID = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const PAYLOAD_B64 = "aGVsbG8=";
const COLLECTION = "documents";

// A transport spy: records every forwarder call so the built query/vars can be
// inspected, and returns no rows (the gate asserts the WIRE, not the acks).
const makeSpy = (): {
  calls: { query: string; vars?: Record<string, string> }[];
  transport: DeltaLogTransport;
} => {
  const calls: { query: string; vars?: Record<string, string> }[] = [];
  const transport: DeltaLogTransport = {
    run: <T = unknown>(
      query: string,
      vars?: Record<string, string>
    ): Promise<readonly TransportRow<T>[]> => {
      calls.push({ query, vars });
      return Promise.resolve([]);
    },
  };
  return { calls, transport };
};

// A delta whose client-supplied scope_user_id is the FORGED value — the push must
// drop it in favour of the server-derived enforced scope.
const forgedScopeDelta: UnackedDelta = {
  id: VALID_ULID,
  scope_user_id: CLIENT_FORGED_SCOPE,
  doc_id: VALID_ULID,
  doc_schema_version: 1,
  payload: PAYLOAD_B64,
};

describe("the delta-log push is fail-closed on the server-derived perimeter", () => {
  test("a push stamps the server-derived scope and never the client-supplied one", async () => {
    const spy = makeSpy();
    await pushDeltaBatch([forgedScopeDelta], {
      transport: spy.transport,
      flushVerdict: "flush",
      collection: COLLECTION,
      enforcedScopeUserId: ENFORCED_SCOPE,
    });

    const wire = JSON.stringify(spy.calls);
    // The enforced scope is what lands on the wire; the forged client scope is
    // dropped entirely — never bound as a variable, never inlined.
    expect(wire).toContain(ENFORCED_SCOPE);
    expect(wire).not.toContain(CLIENT_FORGED_SCOPE);
  });

  test("a push with no enforced scope is rejected, never falling back to the client scope", async () => {
    const spy = makeSpy();
    await expect(
      pushDeltaBatch([forgedScopeDelta], {
        transport: spy.transport,
        flushVerdict: "flush",
        collection: COLLECTION,
        enforcedScopeUserId: "",
      })
    ).rejects.toBeInstanceOf(MissingEnforcedScopeError);
    // Nothing reached the transport — the perimeter refused before any egress.
    expect(spy.calls).toHaveLength(0);
  });
});
