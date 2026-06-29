import { describe, expect, test } from "vitest";

// Conformance gate for the thin offline write queue (outbox) and its default-
// safe flush-gate / quarantine stub.
//
// The deterministic in-memory queue is the contract here; real on-disk
// durability across a process restart rides the local store and is covered by an
// operator drill, not this gate.
//
// The paired mutation twin (`outbox.mutation.test.ts`) replicates the checkers
// below and runs them against deliberately-wrong queues (anti-vacuous).

interface OutboxItem {
  readonly id: string;
  readonly payload: unknown;
  readonly scope_user_id: string;
}

interface OfflineWriteQueue {
  readonly enqueue: (payload: unknown, scopeUserId: string) => OutboxItem;
  readonly flush: () => unknown;
  readonly list: () => readonly OutboxItem[];
  readonly peek: () => OutboxItem | undefined;
  readonly quarantine: () => unknown;
}

interface OutboxModule {
  readonly createOfflineWriteQueue: () => OfflineWriteQueue;
}

const ALICE = "user:alice";
const BOB = "user:bob";

const loadQueue = async (): Promise<OfflineWriteQueue> => {
  const mod = (await import("./outbox")) as unknown as OutboxModule;
  return mod.createOfflineWriteQueue();
};

// --- Checkers (replicated verbatim in the mutation twin) ---------------------

// An item read back carries the scope_user_id STAMPED at enqueue, never a value
// re-derived from an ambient/different subject at read time.
const scopeDurabilityViolations = (
  q: OfflineWriteQueue,
  scopeAtEnqueue: string
): string[] => {
  q.enqueue({ title: "draft" }, scopeAtEnqueue);
  const violations: string[] = [];
  for (const item of q.list()) {
    if (item.scope_user_id !== scopeAtEnqueue) {
      violations.push(
        `item ${item.id}: scope_user_id ${item.scope_user_id} ≠ stamped ${scopeAtEnqueue}`
      );
    }
  }
  return violations;
};

// The stub flush() never auto-flushes — it HOLDS the queue, so no enqueued item
// is sent or discarded.
const autoFlushViolations = (q: OfflineWriteQueue): string[] => {
  q.enqueue({ title: "a" }, ALICE);
  q.enqueue({ title: "b" }, ALICE);
  const before = q.list().length;
  q.flush();
  const after = q.list().length;
  return after < before
    ? [`flush() discarded ${before - after} held item(s) — stub must HOLD`]
    : [];
};

// enqueue never throws/blocks (the offline data path is open).
const enqueueBlockViolations = (q: OfflineWriteQueue): string[] => {
  try {
    q.enqueue({ title: "offline-edit" }, ALICE);
    return [];
  } catch (error) {
    return [`enqueue blocked offline: ${String(error)}`];
  }
};

describe("the offline write queue stamps scope durably and the flush-gate stub holds", () => {
  test("enqueue never blocks — an offline-edit is accepted without throwing", async () => {
    const q = await loadQueue();
    expect(enqueueBlockViolations(q)).toEqual([]);
    expect(q.list().length).toBeGreaterThan(0);
  });

  test("each item retains the scope_user_id stamped at enqueue — never re-derived from an ambient subject", async () => {
    const q = await loadQueue();
    expect(scopeDurabilityViolations(q, ALICE)).toEqual([]);
  });

  test("items enqueued under different subjects each keep their own stamped scope_user_id", async () => {
    const q = await loadQueue();
    const aliceItem = q.enqueue({ title: "alice-draft" }, ALICE);
    const bobItem = q.enqueue({ title: "bob-draft" }, BOB);
    const byId = new Map(q.list().map((item) => [item.id, item]));
    expect(byId.get(aliceItem.id)?.scope_user_id).toBe(ALICE);
    expect(byId.get(bobItem.id)?.scope_user_id).toBe(BOB);
  });

  test("the flush() STUB never auto-flushes — it HOLDS every enqueued item", async () => {
    const q = await loadQueue();
    expect(autoFlushViolations(q)).toEqual([]);
  });

  test("quarantine() holds items without merging or discarding and preserves their original scope_user_id", async () => {
    const q = await loadQueue();
    q.enqueue({ title: "alice-draft" }, ALICE);
    q.enqueue({ title: "bob-draft" }, BOB);
    const before = q.list().length;
    q.quarantine();
    const held = q.list();
    // Nothing discarded or merged, and the original scope survives quarantine.
    expect(held.length).toBe(before);
    expect(held.map((item) => item.scope_user_id).sort()).toEqual(
      [ALICE, BOB].sort()
    );
  });
});
