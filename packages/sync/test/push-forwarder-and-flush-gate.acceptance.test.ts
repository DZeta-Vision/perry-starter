// Acceptance — the push routes through the single forwarder transport and the
// single revocation-discovery flush authority, carrying the payload opaquely.
//
// Asserts, with an in-memory transport spy (no sidecar needed): the push reaches
// cloud SurrealDB ONLY through the one injected forwarder transport, and the
// opaque base64 payload travels through it VERBATIM — never JSON-parsed or
// decoded on this path (the daemon-opaque-transport contract); an over-limit
// batch never reaches the forwarder (the bound is checked before any transport
// call); the push routes through the injected flush verdict and never re-derives
// the revocation decision — a "quarantine"/"hold" verdict performs NO ingestion
// and preserves the queue, while a "flush" verdict ingests; and a same-subject
// re-flush carries the IDENTICAL ULID dedup keys (the client never re-mints ids),
// so the server treats the retry as idempotent.
//
// The real decideFlush authority is imported DYNAMICALLY inside the test bodies
// to show the wiring without a static cross-package build edge.
//
// RED PHASE: every test is skipped until the forwarder push is wired.

import { expect, test } from "vitest";
import {
  BatchTooLargeError,
  MAX_PUSH_BATCH,
  pushDeltaBatch,
} from "../src/push";

const COLLECTION = "documents";
// base64 of "hello" — an opaque, transport-only update payload. If the push ever
// decoded it, this exact string would not survive verbatim on the wire.
const PAYLOAD_B64 = "aGVsbG8=";
const SCOPE = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

interface SpyCall {
  readonly query: string;
  readonly vars?: Record<string, string>;
}

// A transport spy: records every forwarder call and returns canned acks so the
// push can complete without a real store. `nextCursor` advances per call so the
// returned cursors look server-assigned.
const makeSpy = () => {
  const calls: SpyCall[] = [];
  let nextCursor = 1;
  return {
    calls,
    transport: {
      run: (query: string, vars?: Record<string, string>) => {
        calls.push({ query, vars });
        const cursor = nextCursor;
        nextCursor += 1;
        return Promise.resolve([{ status: "OK" as const, result: { cursor } }]);
      },
    },
  };
};

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

type DecideFlush = (input: {
  online: boolean;
  revalidated: boolean;
  revocationOutcome?: "revoked" | "valid";
  sinceReconnectMs?: number;
}) => "flush" | "hold" | "quarantine";

const loadDecideFlush = async (): Promise<DecideFlush> => {
  const mod = await dyn("@perry-starter/data/flush-gate");
  return mod.decideFlush as DecideFlush;
};

const makeDelta = (id: string) => ({
  id,
  scope_user_id: SCOPE,
  doc_id: "01J0XQT8Z9N3H6K2M5P7R9T1V3",
  doc_schema_version: 1,
  payload: PAYLOAD_B64,
});

test("the push reaches the forwarder transport and carries the base64 payload verbatim, never decoded", async () => {
  const spy = makeSpy();
  await pushDeltaBatch([makeDelta("01ARZ3NDEKTSV4RRFFQ69G5FAV")], {
    transport: spy.transport,
    flushVerdict: "flush",
    collection: COLLECTION,
  });

  // The forwarder was the sole egress, and the opaque payload survived verbatim.
  expect(spy.calls.length).toBeGreaterThan(0);
  const wire = JSON.stringify(spy.calls);
  expect(wire).toContain(PAYLOAD_B64);
});

test("an over-limit batch never reaches the forwarder (the bound is checked before any transport call)", async () => {
  const spy = makeSpy();
  const overLimit = Array.from({ length: MAX_PUSH_BATCH + 1 }, (_, i) =>
    makeDelta(`01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(3, "0")}`)
  );

  await expect(
    pushDeltaBatch(overLimit, {
      transport: spy.transport,
      flushVerdict: "flush",
      collection: COLLECTION,
    })
  ).rejects.toThrow(BatchTooLargeError);
  expect(spy.calls).toHaveLength(0);
});

test("a session revoked while offline routes to quarantine via the flush authority — no ingestion, queue preserved", async () => {
  const decideFlush = await loadDecideFlush();
  const spy = makeSpy();
  // The first-reconnect revalidation found the session revoked while offline.
  const verdict = decideFlush({
    online: true,
    revalidated: true,
    revocationOutcome: "revoked",
  });
  expect(verdict).toBe("quarantine");

  const result = await pushDeltaBatch(
    [makeDelta("01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    {
      transport: spy.transport,
      flushVerdict: verdict,
      collection: COLLECTION,
    }
  );

  // Quarantine ingests nothing — the queue is held intact, never flushed.
  expect(spy.calls).toHaveLength(0);
  expect(result.outcome).toBe("quarantined");
  expect(result.acks).toEqual([]);
});

test("an offline / un-revalidated verdict holds — the push never flushes the queue", async () => {
  const decideFlush = await loadDecideFlush();
  const spy = makeSpy();
  // Still offline: the gate holds, never flushes.
  const verdict = decideFlush({ online: false, revalidated: false });
  expect(verdict).toBe("hold");

  const result = await pushDeltaBatch(
    [makeDelta("01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    {
      transport: spy.transport,
      flushVerdict: verdict,
      collection: COLLECTION,
    }
  );

  expect(spy.calls).toHaveLength(0);
  expect(result.outcome).toBe("held");
});

test("a same-subject re-flush carries the identical ULID dedup keys so the server treats it as idempotent", async () => {
  const decideFlush = await loadDecideFlush();
  // A revalidated, affirmatively-valid (same-subject) session releases the flush.
  const verdict = decideFlush({
    online: true,
    revalidated: true,
    revocationOutcome: "valid",
  });
  expect(verdict).toBe("flush");

  const deltas = [
    makeDelta("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    makeDelta("01BX5ZZKBKACTAV9WEVGEMMVRZ"),
  ];
  const idsSentBy = (calls: readonly SpyCall[]) => {
    const wire = JSON.stringify(calls);
    return deltas.filter((d) => wire.includes(d.id)).map((d) => d.id);
  };

  const firstSpy = makeSpy();
  await pushDeltaBatch(deltas, {
    transport: firstSpy.transport,
    flushVerdict: verdict,
    collection: COLLECTION,
  });
  const secondSpy = makeSpy();
  await pushDeltaBatch(deltas, {
    transport: secondSpy.transport,
    flushVerdict: verdict,
    collection: COLLECTION,
  });

  // The retry carries exactly the same id set — the client re-mints nothing, so
  // the server `id` UNIQUE dedup makes the re-flush a no-op.
  expect(idsSentBy(secondSpy.calls)).toEqual(idsSentBy(firstSpy.calls));
  expect(idsSentBy(firstSpy.calls)).toEqual(deltas.map((d) => d.id));
});
