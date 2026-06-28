import { documentSchema } from "@perry-starter/db";
import { env } from "@perry-starter/env/server";
import type {
  DocumentCreateInput,
  DocumentRecord,
  DocumentsDataSeam,
  DocumentUpdateInput,
} from "./documents";
import { signinRecord, sql } from "./surreal-http";

// Local-sidecar implementation of the data seam, driven entirely over
// SurrealDB's HTTP API via native fetch. Every per-request query authenticates
// as `Authorization: Bearer ${sessionToken}` — a scoped, non-root record-access
// session bound by the table's row-level permissions. The root credential is
// never used here; it is reserved for the separate bootstrap/DDL path.

const TABLE = "documents";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;
const ULID_RADIX = 32;
const RECORD_PREFIX = `${TABLE}:`;

const CREATE_DOCUMENT =
  'CREATE type::record("documents", $id) SET title = $title, body_preview = $body_preview;';
const READ_DOCUMENT = 'SELECT * FROM type::record("documents", $id);';
const DELETE_DOCUMENT = 'DELETE type::record("documents", $id);';
const LIST_DOCUMENTS = 'SELECT * FROM type::table("documents");';
const SET_DOCUMENT_PREFIX = 'UPDATE type::record("documents", $id) SET ';

// Client-minted Crockford-base32 ULID: a 48-bit timestamp followed by 80 bits of
// randomness, the convention for record ids.
const mintUlid = (): string => {
  const chars = new Array<string>(ULID_TIME_LEN + ULID_RANDOM_LEN);
  let time = Date.now();
  for (let i = ULID_TIME_LEN - 1; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[time % ULID_RADIX] as string;
    time = Math.floor(time / ULID_RADIX);
  }
  const random = new Uint8Array(ULID_RANDOM_LEN);
  crypto.getRandomValues(random);
  for (let i = 0; i < ULID_RANDOM_LEN; i += 1) {
    chars[ULID_TIME_LEN + i] = CROCKFORD[
      (random[i] as number) % ULID_RADIX
    ] as string;
  }
  return chars.join("");
};

const stripTable = (recordId: string): string =>
  recordId.startsWith(RECORD_PREFIX)
    ? recordId.slice(RECORD_PREFIX.length)
    : recordId;

// Normalize a raw record returned by the sidecar into the canonical record
// shape, validating it against the single-sourced Zod schema.
const normalize = (raw: unknown): DocumentRecord => {
  const row = raw as Record<string, unknown>;
  return documentSchema.parse({
    id: stripTable(String(row.id)),
    title: row.title,
    body_preview: row.body_preview,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
};

const firstRecord = (result: unknown): unknown => {
  if (Array.isArray(result)) {
    return result[0];
  }
  return;
};

export interface LocalDocumentsConfig {
  readonly db: string;
  readonly ns: string;
  // A scoped record-access identity. When omitted, a single local identity is
  // provisioned on first use; the per-user credential is wired from the auth
  // tier later.
  readonly session?: { readonly email: string; readonly pass: string };
  readonly url: string;
}

export const createDocumentsLocal = (
  config: LocalDocumentsConfig
): DocumentsDataSeam => {
  const { url, ns, db } = config;
  const credentials = config.session ?? {
    email: `local-${mintUlid().toLowerCase()}@perry.local`,
    pass: mintUlid(),
  };

  let sessionPromise: Promise<string> | undefined;
  const sessionToken = (): Promise<string> => {
    sessionPromise ??= signinRecord(url, {
      ns,
      db,
      ac: "account",
      email: credentials.email,
      pass: credentials.pass,
    });
    return sessionPromise;
  };
  const bearer = async () => ({
    kind: "bearer" as const,
    token: await sessionToken(),
  });

  return {
    async create(input: DocumentCreateInput): Promise<DocumentRecord> {
      const auth = await bearer();
      const id = mintUlid();
      const rows = await sql(url, ns, db, auth, CREATE_DOCUMENT, {
        id,
        title: input.title,
        body_preview: input.body_preview ?? "",
      });
      const raw = firstRecord(rows[0]?.result);
      if (!raw) {
        throw new Error("document create returned no record");
      }
      return normalize(raw);
    },

    async read(id: string): Promise<DocumentRecord> {
      const auth = await bearer();
      const rows = await sql(url, ns, db, auth, READ_DOCUMENT, { id });
      const raw = firstRecord(rows[0]?.result);
      if (!raw) {
        throw new Error(`document not found: ${id}`);
      }
      return normalize(raw);
    },

    async update(
      id: string,
      patch: DocumentUpdateInput
    ): Promise<DocumentRecord> {
      const auth = await bearer();
      // Build the SET clause from a fixed allowlist of field fragments; the
      // values themselves are always passed as bind variables.
      const assignments: string[] = [];
      const vars: Record<string, string> = { id };
      if (patch.title !== undefined) {
        assignments.push("title = $title");
        vars.title = patch.title;
      }
      if (patch.body_preview !== undefined) {
        assignments.push("body_preview = $body_preview");
        vars.body_preview = patch.body_preview;
      }
      if (assignments.length === 0) {
        throw new Error("document update requires at least one field");
      }
      const query = `${SET_DOCUMENT_PREFIX}${assignments.join(", ")};`;
      const rows = await sql(url, ns, db, auth, query, vars);
      const raw = firstRecord(rows[0]?.result);
      if (!raw) {
        throw new Error(`document not found: ${id}`);
      }
      return normalize(raw);
    },

    async delete(id: string): Promise<void> {
      const auth = await bearer();
      await sql(url, ns, db, auth, DELETE_DOCUMENT, { id });
    },

    async list(): Promise<readonly DocumentRecord[]> {
      const auth = await bearer();
      const rows = await sql(url, ns, db, auth, LIST_DOCUMENTS);
      const result = rows[0]?.result;
      if (!Array.isArray(result)) {
        return [];
      }
      return result.map((raw) => normalize(raw));
    },
  };
};

// Default singleton, wired from the validated server environment contract.
export const documentsData: DocumentsDataSeam = createDocumentsLocal({
  url: env.SURREAL_URL,
  ns: env.SURREAL_NS,
  db: env.SURREAL_DB,
});

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "local" as const;
