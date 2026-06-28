// Canonical hand-authored Zod primitives for @perry-starter/db.
//
// These runtime validators are the single source of truth for the durable data
// shapes. surrealkit typegen emits TypeScript interfaces only — a possible
// upstream INPUT, never the canonical validator — and is deliberately not wired
// in here. Every consumer (api / auth / data-seam / sync) imports these shapes
// and never redeclares them, so the wire and the store cannot drift.

import { z } from "zod";

// Client-minted 26-char Crockford ULID — the dedup / op-id key.
export const ulidId = z.ulid();

// A required, non-empty owner/scope identifier.
export const scopeUserId = z.string().min(1);

// Server-assigned monotonic per-(collection, scope) integer. Transport-only:
// never a client clock, never a ULID, and never a CRDT op / peer / version
// value. A ULID-as-cursor would silently drop a causally-later op that minted a
// smaller ULID under offline/concurrent writers — this type forecloses that bug.
export const serverCursor = z.number().int();

// Server-generated ISO-8601 timestamp.
export const isoTimestamp = z.iso.datetime();

// Opaque, transport-only base64 payload. The browser/sidecar tier encodes the
// raw CRDT update; the transport layer carries it and never decodes it.
export const base64Payload = z.base64();
