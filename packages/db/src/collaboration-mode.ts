import { z } from "zod";

// Every collection declares one collaboration mode. `'private'` collections
// converge by last-writer-wins over the delta-log; `'collaborative'` collections
// use the CRDT path. This enum is the only place the mode vocabulary is defined.
export const collaborationModeSchema = z.enum(["private", "collaborative"]);

export type CollaborationMode = z.infer<typeof collaborationModeSchema>;

// Single-sourced, immutable per-collection registry. Frozen at runtime and
// readonly at compile time (`as const`), so the materialization-locus single
// source cannot drift. The generic `documents` collection has an entry.
export const collaborationModeRegistry = Object.freeze({
  documents: "private",
} as const);

export type CollaborationModeRegistry = typeof collaborationModeRegistry;
