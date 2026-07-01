// The concrete loro-crdt adapter — BROWSER TIER ONLY.
//
// This is the ONLY file in the repo that imports the loro-crdt engine. Loro is
// in-process WASM and is foreclosed in the Perry daemon (no WASM/V8); it runs
// only here in the browser, the sole projection writer in v1. The daemon never
// imports, decodes, or materializes Loro — it transports the opaque base64
// payload this adapter produces. The tier-boundary build guard denylists
// loro-crdt in the daemon graph while leaving it legal under apps/web.
//
// The adapter wraps a `LoroDoc` and implements the browser-tier capture port
// (`BrowserCrdtDoc`: applyLocalEdit + exportDeltaBase64) plus the merge/read port
// the projection materializer consumes (importDelta + toJSON). Deltas cross the
// envelope boundary as opaque base64: Loro emits a raw Uint8Array that we encode
// ourselves (Loro produces no base64). Incremental export checkpoints on
// `oplogVersion()` (the committed-history version vector — never `version()`,
// which shifts on checkout/time-travel).

import { LoroDoc } from "loro-crdt";
import type { BrowserCrdtDoc } from "./loro-editor";

// Loro emits raw bytes; the envelope payload is base64. Encode/decode here, at
// the envelope boundary (the `loro-crdt/base64` subpath is a WASM-inlining
// bundler entry, NOT a delta codec).
const toBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

// The browser capture port plus the merge/read port the materializer consumes.
export interface LoroBackedCrdtDoc extends BrowserCrdtDoc {
  // Apply one opaque base64 Loro update. Idempotent (re-importing converged bytes
  // is a no-op) and order-independent (missing-dependency ops buffer until ready).
  importDelta(payloadBase64: string): void;
  // The underlying document — edits target its containers (e.g.
  // `loroDoc.getText("body").insert(...)`) inside an `applyLocalEdit` callback.
  readonly loroDoc: LoroDoc;
  // The merged read-model view used to project the collaborative row.
  toJSON(): unknown;
}

export const createLoroBrowserCrdtDoc = (): LoroBackedCrdtDoc => {
  const loroDoc = new LoroDoc();
  // The committed-history checkpoint. Advanced after each export so the next
  // export carries only the new ops (incremental update).
  let checkpoint = loroDoc.oplogVersion();

  const adapter: LoroBackedCrdtDoc = {
    loroDoc,
    applyLocalEdit(mutate) {
      mutate(adapter);
      loroDoc.commit();
    },
    exportDeltaBase64() {
      const delta = loroDoc.export({ mode: "update", from: checkpoint });
      checkpoint = loroDoc.oplogVersion();
      return toBase64(delta);
    },
    importDelta(payloadBase64) {
      loroDoc.import(fromBase64(payloadBase64));
    },
    toJSON() {
      return loroDoc.toJSON();
    },
  };

  return adapter;
};
