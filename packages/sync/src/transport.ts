// The opaque delta-log transport seam shared by the push and pull surfaces.
//
// It is ONE parameterized SurrealQL executor bound to the single post-auth
// forwarder and the single runtime (non-DDL) cloud-SurrealDB binding (the cloud
// gatekeeper): all sync delta-log push/pull reaches cloud SurrealDB ONLY through
// it, and the client/daemon never connect to cloud SurrealDB directly.
//
// It is INJECTED into push/pull (never imported by them from a concrete store),
// so packages/sync keeps no static build edge to a data implementation and the
// daemon path carries the opaque base64 payload verbatim — it is NEVER decoded
// here. Values travel as parameterized bind variables, never interpolated into
// the statement string.

export interface TransportRow<T = unknown> {
  readonly result: T;
  readonly status: "OK" | "ERR";
}

export interface DeltaLogTransport {
  readonly run: <T = unknown>(
    query: string,
    vars?: Record<string, string>
  ) => Promise<readonly TransportRow<T>[]>;
}
