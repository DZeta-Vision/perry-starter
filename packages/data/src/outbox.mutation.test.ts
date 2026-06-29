import { describe, expect, test } from "vitest";

// Mutation twin for outbox.gate.test.ts — the anti-vacuous proof.
//
// The gate's three checkers are replicated here and run against deliberately-
// wrong queues, with a clean reference queue as the not-always-red control. The
// real `outbox.ts` module is never imported — the twin proves the GATE's logic
// discriminates, so it is self-contained.

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

const ALICE = "user:alice";
const AMBIENT = "user:ambient";

interface QueueOverrides {
  readonly autoFlush?: boolean; // flush() empties the queue (sends/discards)
  readonly blockEnqueue?: boolean; // enqueue throws (offline data path blocked)
  readonly reDeriveScope?: string; // read-back scope re-derived from this subject
}

// Correct by default; one knob per mutation.
const makeQueue = (overrides: QueueOverrides = {}): OfflineWriteQueue => {
  let seq = 0;
  const items: OutboxItem[] = [];
  const view = (): OutboxItem[] =>
    overrides.reDeriveScope === undefined
      ? items
      : items.map((item) => ({
          ...item,
          scope_user_id: overrides.reDeriveScope as string,
        }));
  return {
    enqueue: (payload, scopeUserId) => {
      if (overrides.blockEnqueue) {
        throw new Error("auth gate blocked the offline write");
      }
      seq += 1;
      const item: OutboxItem = {
        id: `item:${seq}`,
        payload,
        scope_user_id: scopeUserId,
      };
      items.push(item);
      return item;
    },
    flush: () => {
      if (overrides.autoFlush) {
        items.length = 0;
      }
      return { held: items.length };
    },
    list: () => view(),
    peek: () => view()[0],
    quarantine: () => ({ quarantined: items.length }),
  };
};

// --- Checkers (replicated from the gate) -------------------------------------

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

const enqueueBlockViolations = (q: OfflineWriteQueue): string[] => {
  try {
    q.enqueue({ title: "offline-edit" }, ALICE);
    return [];
  } catch (error) {
    return [`enqueue blocked offline: ${String(error)}`];
  }
};

describe("the scope-durability checker fires on a re-deriving queue", () => {
  test("a queue that re-derives scope_user_id from an ambient subject at read reddens; the stamping queue stays green", () => {
    expect(
      scopeDurabilityViolations(makeQueue({ reDeriveScope: AMBIENT }), ALICE)
        .length
    ).toBeGreaterThan(0);
    expect(scopeDurabilityViolations(makeQueue(), ALICE)).toEqual([]);
  });
});

describe("the auto-flush checker fires on a flushing stub", () => {
  test("a flush() stub that sends/discards queued items reddens; the holding stub stays green", () => {
    expect(
      autoFlushViolations(makeQueue({ autoFlush: true })).length
    ).toBeGreaterThan(0);
    expect(autoFlushViolations(makeQueue())).toEqual([]);
  });
});

describe("the enqueue-never-blocks checker fires on a blocked offline write", () => {
  test("an enqueue that throws while offline reddens; the non-blocking queue stays green", () => {
    expect(
      enqueueBlockViolations(makeQueue({ blockEnqueue: true })).length
    ).toBeGreaterThan(0);
    expect(enqueueBlockViolations(makeQueue())).toEqual([]);
  });
});
