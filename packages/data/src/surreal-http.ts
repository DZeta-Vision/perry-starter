// SurrealDB v3 HTTP client helpers, driven entirely over native fetch — no
// in-process SurrealDB SDK or WASM. The wire contract: POST /sql takes the raw
// SurrealQL string as the body (text/plain, never a JSON wrapper); the literal
// lowercase surreal-ns / surreal-db headers select the namespace and database;
// the response is a JSON array of one { status, result } per statement. HTTP 200
// does not imply success, so every per-statement status is checked. Values are
// passed as query-string bind variables, never interpolated into the body.

const SURREAL_NS_HEADER = "surreal-ns";
const SURREAL_DB_HEADER = "surreal-db";
const JSON_ACCEPT = "application/json";

export type SurrealAuth =
  | { readonly kind: "basic"; readonly user: string; readonly pass: string }
  | { readonly kind: "bearer"; readonly token: string };

export interface SqlResult<T = unknown> {
  readonly result: T;
  readonly status: "OK" | "ERR";
  readonly time?: string;
}

export type RecordSigninBody = {
  readonly ns: string;
  readonly db: string;
  readonly ac: string;
} & Record<string, unknown>;

const authorizationHeader = (auth: SurrealAuth): string => {
  if (auth.kind === "basic") {
    return `Basic ${btoa(`${auth.user}:${auth.pass}`)}`;
  }
  return `Bearer ${auth.token}`;
};

// Consume the response body through res.body.getReader() + reader.read(). Under
// the daemon's fetch, a runtime existence check on the reader method reports it
// as missing even though it works, so the reader is used directly here and is
// never feature-detected.
const readBody = async (res: Response): Promise<string> => {
  const stream = res.body;
  if (!stream) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
};

// Run raw SurrealQL over POST /sql. `vars` are appended as query-string bind
// variables ($vars) and are never spliced into the query string itself. Throws
// on any non-2xx response and on any per-statement status of "ERR".
export const sql = async <T = unknown>(
  url: string,
  ns: string,
  db: string,
  auth: SurrealAuth,
  query: string,
  vars?: Record<string, string>
): Promise<SqlResult<T>[]> => {
  const endpoint = vars
    ? `${url}/sql?${new URLSearchParams(vars).toString()}`
    : `${url}/sql`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(auth),
      [SURREAL_NS_HEADER]: ns,
      [SURREAL_DB_HEADER]: db,
      Accept: JSON_ACCEPT,
      "Content-Type": "text/plain",
    },
    body: query,
  });
  const text = await readBody(res);
  if (!res.ok) {
    throw new Error(`SurrealDB HTTP ${res.status}: ${text}`);
  }
  const rows = JSON.parse(text) as SqlResult<T>[];
  const failed = rows.find((row) => row.status === "ERR");
  if (failed) {
    throw new Error(`SurrealQL statement failed: ${String(failed.result)}`);
  }
  return rows;
};

const postAuth = async (
  endpoint: string,
  body: RecordSigninBody
): Promise<{ ok: boolean; token?: string }> => {
  // Accept is mandatory: a sign-in request without it can return an empty body.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": JSON_ACCEPT, Accept: JSON_ACCEPT },
    body: JSON.stringify(body),
  });
  const text = await readBody(res);
  if (!res.ok) {
    return { ok: false };
  }
  const parsed = JSON.parse(text) as { token?: string };
  return { ok: true, token: parsed.token };
};

// Establish a scoped record-access session and return its Bearer token. The
// identity is registered on first use and authenticated on later calls (the
// unique email index makes a repeat registration fail, so the sign-in branch
// covers the returning local user).
export const signinRecord = async (
  url: string,
  body: RecordSigninBody
): Promise<string> => {
  const registered = await postAuth(`${url}/signup`, body);
  if (registered.ok && registered.token) {
    return registered.token;
  }
  const authenticated = await postAuth(`${url}/signin`, body);
  if (!authenticated.token) {
    throw new Error("record-access sign-in returned no session token");
  }
  return authenticated.token;
};
