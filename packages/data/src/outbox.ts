// The thin offline write queue (outbox). The first-reconnect "revalidate before
// any flush" decision is owned solely by the single flush-gate authority
// (`decideFlush` in ./flush-gate); this module carries no revocation branch of
// its own.
//
// Unflushed offline work lives here as a queue of deltas. Each item stamps its
// owning subject (`scope_user_id`) AT ENQUEUE and carries a client-minted,
// lexicographically sortable id used as the idempotent dedup key. The stamped
// subject is never re-derived from an ambient/current subject at read or flush,
// so queued work stays durable under the subject that created it.
//
// For this foundational layer the queue is an in-memory, deterministic
// abstraction: `enqueue` never blocks (the offline data path stays open) and the
// real on-disk durability rides the pluggable local store. The real
// flush/convergence is a later milestone — `flush()` here is a default-safe
// no-op HOLD.

// Crockford base32 alphabet (the ULID encoding).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

const encodeTime = (time: number): string => {
  let remaining = time;
  let out = "";
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ENCODING.charAt(remaining % ENCODING.length) + out;
    remaining = Math.floor(remaining / ENCODING.length);
  }
  return out;
};

const encodeRandom = (): string => {
  const bytes = new Uint8Array(RANDOM_CHARS);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ENCODING.charAt(byte % ENCODING.length);
  }
  return out;
};

// A client-minted, time-sortable identifier — the idempotent dedup key.
const mintId = (time: number): string => encodeTime(time) + encodeRandom();

// A queued offline write. `scope_user_id` is snake_case to match the canonical
// record shape used across the store.
export interface OutboxItem {
  readonly id: string;
  readonly payload: unknown;
  readonly scope_user_id: string;
}

export interface FlushResult {
  readonly held: number;
  readonly status: "held";
}

export interface QuarantineResult {
  readonly held: number;
  readonly status: "quarantined";
}

export interface OfflineWriteQueue {
  readonly enqueue: (payload: unknown, scopeUserId: string) => OutboxItem;
  readonly flush: () => FlushResult;
  readonly list: () => readonly OutboxItem[];
  readonly peek: () => OutboxItem | undefined;
  readonly quarantine: () => QuarantineResult;
}

export const createOfflineWriteQueue = (): OfflineWriteQueue => {
  const items: OutboxItem[] = [];
  return {
    enqueue: (payload, scopeUserId) => {
      // Stamp the owning subject at enqueue and never re-derive it later.
      const item: OutboxItem = {
        id: mintId(Date.now()),
        payload,
        scope_user_id: scopeUserId,
      };
      items.push(item);
      return item;
    },
    list: () => [...items],
    peek: () => items[0],
    // Default-safe HOLD: queued work is never auto-sent or discarded here.
    flush: () => ({ held: items.length, status: "held" }),
    // Default-safe HOLD: quarantined work is held intact — neither merged nor
    // discarded — preserving each item's original stamped subject.
    quarantine: () => ({ held: items.length, status: "quarantined" }),
  };
};
