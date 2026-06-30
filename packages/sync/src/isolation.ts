// Cross-scope isolation perimeter for the delta-log and its copies.
//
// The SOLE isolation perimeter is a SERVER-DERIVED scope = the authenticated
// session's user id. It is applied on BOTH the push and the pull leg, over a
// fully sealed delta table, and it covers EVERY copy of delta data — the cloud
// log, the local store, and the materialized projection. A client-asserted
// scope (anything that travels in the request body) is NEVER trusted: it is
// ignored in favour of the id the server already established for the session, so
// a forged scope can never let one owner read or write another owner's rows.
//
// Defense in depth: the delta table is sealed to record-access sessions (no
// scoped session reads any row directly), so even a missing or bypassed
// transport-layer scope check still denies at the row layer. The server-derived
// scope is the WHERE filter the privileged forwarder applies on top of that.
//
// This module is pure TypeScript over the canonical scope identifier. It never
// imports an engine SDK, Loro, or WASM, and it never reaches the database
// itself — the transport surface threads the derived scope into its queries.

// The minimal authenticated session the perimeter derives from. Only the
// server-established user id is load-bearing. There is deliberately no field for
// a client-asserted scope here: the perimeter must not be derivable from
// anything the client controls.
export interface PerimeterSession {
  readonly user: { readonly id: string };
}

// Every copy of delta data the perimeter must cover. Naming each copy makes the
// "all copies" coverage contract explicit and assertable, so a perimeter that
// silently misses one copy is a detectable gap rather than a quiet breach.
export type DeltaCopy = "cloud-log" | "local-store" | "materialized-projection";
export const DELTA_COPIES: readonly DeltaCopy[] = [
  "cloud-log",
  "local-store",
  "materialized-projection",
] as const;

// The two sync legs the perimeter applies on. Isolation that holds on pull but
// not on push (or vice versa) is a one-way breach, so both are enumerated.
export type SyncLeg = "push" | "pull";
export const SYNC_LEGS: readonly SyncLeg[] = ["push", "pull"] as const;

// The materialized read-model table — the third copy of delta data. The
// delta-log table name is owned by the module surface; this names the projection
// copy the perimeter must equally cover.
export const PROJECTION_TABLE = "document_projection" as const;

// Derive the SOLE perimeter scope from the authenticated session. Server-derived
// and nothing else: never a client-supplied value, never the active organization
// id. This is the only scope the push and pull legs may constrain on.
export const deriveScopeUserId = (session: PerimeterSession): string =>
  session.user.id;

// Resolve the scope the server will actually enforce for a request, given the
// authenticated session AND whatever scope the request body asserted. The
// client-asserted value is IGNORED — it is never read; the returned scope is
// always the server-derived one, so a forged scope cannot widen the perimeter on
// either leg.
export const resolveEnforcedScope = (
  session: PerimeterSession,
  _clientAssertedScopeUserId?: string
): string => deriveScopeUserId(session);
