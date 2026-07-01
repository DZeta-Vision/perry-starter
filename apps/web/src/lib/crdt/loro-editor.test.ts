// Browser-tier collaborative editing contract: Loro runs ONLY in the browser and
// every local edit leaves the browser as an OPAQUE base64 payload handed to the
// transport. The transport (and therefore the daemon) never receives a decoded
// CRDT structure — it moves the base64 string verbatim.
//
// RED PHASE: every test is skipped until the surface is implemented. The real
// loro-crdt LoroDoc-backed adapter is deferred to Execute; these tests drive a
// fake CrdtDoc + a recording transport, so the contract is pinned without the
// dependency.

import { describe, expect, test } from "vitest";
import type { BrowserCrdtDoc, OpaqueDeltaTransport } from "./loro-editor";
import { createCollaborativeEditor } from "./loro-editor";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// base64 of an opaque Loro update.
const OPAQUE_B64 = "aGVsbG8td29ybGQ=";
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const makeFakeDoc = (): BrowserCrdtDoc => ({
  applyLocalEdit: (mutate) => mutate(makeFakeDoc()),
  exportDeltaBase64: () => OPAQUE_B64,
});

interface Recorder extends OpaqueDeltaTransport {
  readonly pushed: { docId: string; payloadBase64: string }[];
}

const makeRecordingTransport = (): Recorder => {
  const pushed: { docId: string; payloadBase64: string }[] = [];
  return {
    pushed,
    push: (delta) => {
      pushed.push(delta);
    },
  };
};

describe("the browser editor hands the transport an opaque base64 delta", () => {
  test("a local edit produces an opaque base64 payload handed to the transport", () => {
    const transport = makeRecordingTransport();
    const editor = createCollaborativeEditor(DOC_ID, makeFakeDoc, transport);
    editor.edit((doc) => doc.applyLocalEdit(() => undefined));

    expect(transport.pushed).toHaveLength(1);
    const [delta] = transport.pushed;
    expect(delta?.docId).toBe(DOC_ID);
    expect(typeof delta?.payloadBase64).toBe("string");
    expect(delta?.payloadBase64).toMatch(BASE64_RE);
  });

  test("the transport never receives a decoded CRDT structure (opaque only)", () => {
    const transport = makeRecordingTransport();
    const editor = createCollaborativeEditor(DOC_ID, makeFakeDoc, transport);
    editor.edit((doc) => doc.applyLocalEdit(() => undefined));

    for (const delta of transport.pushed) {
      // The payload is a base64 string, never a Uint8Array or a parsed object.
      expect(typeof delta.payloadBase64).toBe("string");
      expect(delta.payloadBase64).not.toBeInstanceOf(Uint8Array);
    }
  });
});
