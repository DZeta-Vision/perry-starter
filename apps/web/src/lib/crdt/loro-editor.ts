// Browser-tier collaborative editor surface.
//
// Loro (the loro-crdt engine) runs ONLY here in the browser — never the Perry
// daemon, where in-process WASM/prebuilt-JS is foreclosed. Local edits are
// captured as a raw Loro update and base64-encoded into an OPAQUE payload handed
// to the transport; the daemon moves that base64 string verbatim and never
// decodes it.
//
// The real loro-crdt `LoroDoc`-backed adapter is DEFERRED to Execute (the dep is
// not yet installed, so this slice does NOT import loro-crdt). This file defines
// the thin browser-local CRDT port and the editor factory the adapter plugs into,
// so the red-phase tests pin the browser-tier + opaque-base64 contract without
// pulling in the dependency or racing the lockfile.

// The browser-tier CRDT port. A concrete adapter (Execute) wraps a loro-crdt
// `LoroDoc`: `applyLocalEdit` mutates + commits the doc; `exportDeltaBase64`
// returns the since-checkpoint update ALREADY base64-encoded — the opaque
// transport payload. No method ever returns a decoded CRDT structure.
export interface BrowserCrdtDoc {
  applyLocalEdit(mutate: (doc: BrowserCrdtDoc) => void): void;
  // Returns the opaque base64 Loro update (string), never a Uint8Array.
  exportDeltaBase64(): string;
}

export type BrowserCrdtDocFactory = () => BrowserCrdtDoc;

// What the transport receives: an OPAQUE base64 payload string only. The daemon
// transports this verbatim and never decodes it.
export interface OpaqueDeltaTransport {
  push(delta: { docId: string; payloadBase64: string }): void;
}

export interface CollaborativeEditor {
  // Apply a local edit; the resulting opaque base64 delta is handed to the
  // transport. Never blocks, never decodes on the transport side.
  edit(mutate: (doc: BrowserCrdtDoc) => void): void;
}

export const createCollaborativeEditor = (
  docId: string,
  createDoc: BrowserCrdtDocFactory,
  transport: OpaqueDeltaTransport
): CollaborativeEditor => {
  const doc = createDoc();
  return {
    edit: (mutate) => {
      // Apply the local edit, then hand the transport the resulting OPAQUE
      // base64 delta keyed to the doc. The transport (and the daemon behind it)
      // only ever sees the base64 string — never a decoded CRDT structure.
      doc.applyLocalEdit(mutate);
      transport.push({ docId, payloadBase64: doc.exportDeltaBase64() });
    },
  };
};
