// Mutation twin for the bind-check gate: it replicates the gate's two detectors
// (no-stack-trace, names-the-port) and feeds them the raw-EADDRINUSE rethrow the
// handler must NOT produce — asserting the detectors flag it (so the gate would
// redden). The typed, port-naming, stack-free message is the green control.

import { describe, expect, test } from "vitest";

const STACK_FRAME_RE = /\bat\s+.+:\d+:\d+/;
const ONE_LINE_FIX_RE =
  /(?:free|stop|already in use|use (?:a )?different|--port|choose another|change the port)/i;

const hasStackMarkers = (text: string): boolean =>
  STACK_FRAME_RE.test(text) || text.includes("EADDRINUSE");
const namesPort = (text: string, port: number): boolean =>
  text.includes(String(port));
const hasOneLineFix = (text: string): boolean => ONE_LINE_FIX_RE.test(text);

const BUSY_PORT = 5173;
// The mutant: the handler rethrew the raw error, leaking a stack + EADDRINUSE.
const RAW_EADDRINUSE = [
  "Error: listen EADDRINUSE: address already in use 127.0.0.1:5173",
  "    at Server.setupListenHandle [as _listen2] (node:net:1893:21)",
  "    at listenInCluster (node:net:1958:12)",
].join("\n");
// The control: a generic typed message that names the port + a one-line fix.
const TYPED_MESSAGE =
  "Port 5173 is already in use. Free it, or start with --port <other>.";

describe("the bind-check detectors flag a raw EADDRINUSE rethrow", () => {
  test("the raw rethrow trips the no-stack-trace detector (the gate would redden)", () => {
    expect(hasStackMarkers(RAW_EADDRINUSE)).toBe(true);
  });

  test("a port-less generic message fails the names-the-port detector (the gate would redden)", () => {
    expect(namesPort("The port is already in use.", BUSY_PORT)).toBe(false);
  });

  test("the typed message is stack-free, names the port, and carries a one-line fix (not always-firing)", () => {
    expect(hasStackMarkers(TYPED_MESSAGE)).toBe(false);
    expect(namesPort(TYPED_MESSAGE, BUSY_PORT)).toBe(true);
    expect(hasOneLineFix(TYPED_MESSAGE)).toBe(true);
  });
});
