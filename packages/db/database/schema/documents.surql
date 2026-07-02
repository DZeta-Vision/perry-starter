-- Merged local data-engine schema for the documents entity.
--
-- Driven over SurrealDB's HTTP API only. Every table declares an explicit
-- row-level PERMISSIONS clause (none is left to the implicit default): owner-data
-- tables scope to the authenticated record ($auth) so a scoped, non-root session
-- can never read or mutate another owner's rows, while the credential table and
-- the delta-log are sealed PERMISSIONS NONE. The bootstrap root credential is
-- used for this DDL only; per-request queries run through a scoped record-access
-- session whose $auth is the matched user record.

-- Record-access perimeter: a per-session credential whose $auth is a user record
-- (not a coarse system user). Sign-up registers a user; sign-in authenticates an
-- existing one. The unique email index makes registration idempotent.
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET email = $email, pass = crypto::argon2::generate($pass), role = $role ?? 'member' )
  SIGNIN ( SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(pass, $pass) )
  DURATION FOR TOKEN 18m, FOR SESSION 12h;

-- DB-layer JWT verification (the second leg's offline-token check). A presented
-- Bearer is accepted ONLY if it is an unexpired token signed by the pinned ES256
-- public key; a tampered / expired / wrong-algorithm token fails closed (the
-- request is rejected, $auth never resolves, row PERMISSIONS deny). The key is a
-- NON-PROD test public key whose private half lives in @perry-starter/auth/test-jwt;
-- production verification uses the cloud authority's rotating ES256 JWKS.
DEFINE ACCESS api ON DATABASE TYPE JWT ALGORITHM ES256 KEY "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfjrw6CpYRRgSsB9myFHWEG5hsGBl
/UeQHpuVS6j17loMAtMiXzarmp/zKupyPCHIxiaxiZaSXPohTuOBy6iiNw==
-----END PUBLIC KEY-----";

-- The credential table is sealed to record-access sessions: PERMISSIONS NONE
-- means no scoped session can read or mutate any credential row, so one user can
-- never read another user's email/argon2 hash. Sign-up's CREATE and sign-in's
-- SELECT run in the access definition's privileged context, which bypasses table
-- PERMISSIONS, so registration and authentication still work end to end while a
-- scoped session reads []. Declared explicitly (not left to the implicit default)
-- so the table cannot escape the permissions audit. SCHEMAFULL pins the shape to
-- exactly the two credential fields; the unique email index requires email to be
-- a defined field under SCHEMAFULL. This table definition follows the access
-- block (which establishes the namespace/database) and precedes the index (a
-- bare index would otherwise auto-create the credential table schemaless+open).
DEFINE TABLE user SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD email ON user TYPE string;
DEFINE FIELD pass ON user TYPE string;
-- The GLOBAL app-authz role (member/admin/superadmin), set from the signup claim
-- and defaulting to the lowest tier. This is the claim the row-level PERMISSIONS
-- read as $auth.role — distinct from any org-structural role.
DEFINE FIELD role ON user TYPE string DEFAULT 'member';
-- The single-sourced reversible-deactivate state (active|deactivated). A
-- deactivate is a SOFT flip of this field, never a row DELETE, so a deactivated
-- account is fully recoverable by flipping it back to 'active'. Defaults to
-- 'active' so a freshly registered account is enabled.
DEFINE FIELD status ON user TYPE string DEFAULT 'active';
-- The keyset sort key: server-stamped, immutable, monotonic-per-insert creation
-- time. The admin user list keysets on this (newest-first) rather than deep-paging
-- with OFFSET/START.
DEFINE FIELD created_at ON user TYPE datetime DEFAULT time::now() READONLY;
-- Last-active and inviter are optional list filters; unset until the host stamps
-- them (an as-yet-inactive or self-registered account carries neither).
DEFINE FIELD last_active ON user TYPE option<datetime>;
DEFINE FIELD invited_by ON user TYPE option<string>;

DEFINE INDEX user_email ON user FIELDS email UNIQUE;

-- Keyset read indexes. The admin user list pulls `WHERE [status = $s AND]
-- created_at < $cursor ORDER BY created_at DESC LIMIT $n` — an index-backed range
-- walk, never an OFFSET/START deep-page and never a TableScan. The single-field
-- index backs the unfiltered keyset; the trailing composite backs the
-- status-scoped keyset (the equality-lead + range shape the query planner covers
-- with an IndexScan).
DEFINE INDEX idx_user_created ON user FIELDS created_at;
DEFINE INDEX idx_user_status_created ON user FIELDS status, created_at;

-- The documents entity. Owned by the authenticated record; only the owner may
-- read or write their own rows. No table or field is left defaulting open.
DEFINE TABLE documents SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth
    FOR create WHERE owner = $auth;

DEFINE FIELD owner ON documents TYPE record<user> DEFAULT $auth VALUE $auth READONLY;
DEFINE FIELD title ON documents TYPE string;
DEFINE FIELD body_preview ON documents TYPE string DEFAULT '';
DEFINE FIELD created_at ON documents TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON documents TYPE datetime VALUE time::now();

-- The delta-log table is sealed: it grants no access to record-access sessions
-- at all. The cross-scope isolation perimeter over this table is enforced
-- server-side later; here it is only shaped as fully denied. It is anchored to
-- the document (doc_id), append-only, and dedup-safe on the client-minted op-id.
DEFINE TABLE document_delta SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD scope_user_id ON document_delta TYPE string;
DEFINE FIELD doc_id ON document_delta TYPE string;
-- The client-minted ULID op-id, carried as a field and pinned UNIQUE below so a
-- replayed op converges to a single row (idempotent dedup at the table layer).
-- The record id is also the op-id (document_delta:<ulid>), so an UPSERT replay
-- updates in place; the UNIQUE index additionally forbids a different record id
-- from reusing the same op-id.
DEFINE FIELD op_id ON document_delta TYPE string;
-- The document schema version travels with every delta so a reader can detect an
-- envelope minted under a drifted/incompatible document shape.
DEFINE FIELD doc_schema_version ON document_delta TYPE int;
-- The server-assigned monotonic per-(collection, scope) cursor — transport and
-- keyset ordering only, never a client clock and never the ULID. OPTIONAL on the
-- row because it does not exist until the server mints it from the named sequence
-- at ingest; an as-yet-unminted delta carries no cursor.
DEFINE FIELD cursor ON document_delta TYPE option<int>;
DEFINE FIELD payload ON document_delta TYPE string;

-- Idempotent-replay dedup: a duplicate op-id can never create a second row.
DEFINE INDEX idx_document_delta_op_id ON document_delta FIELDS op_id UNIQUE;
-- The trailing (scope_user_id, cursor) composite range index range-backs the
-- since-cursor keyset pull (WHERE scope_user_id = $s AND cursor > $since ORDER BY
-- cursor ASC) at a cost proportional to the number of new deltas — never an
-- OFFSET/START deep-page and never a full table scan.
DEFINE INDEX idx_document_delta_scope_cursor ON document_delta FIELDS scope_user_id, cursor;

-- The materialized read-model projection — the THIRD copy of delta data the
-- cross-scope isolation perimeter must cover, alongside the cloud log and the
-- local store. Sealed PERMISSIONS NONE exactly like the delta-log: a record-access
-- session reads zero rows directly (defense in depth), and the only perimeter over
-- it is the server-derived scope_user_id the privileged forwarder constrains on. A
-- single owning writer (the browser projection writer) owns every column including
-- the model-tagged embedding (so one index never mixes embedding spaces);
-- updated_cursor is the server-assigned integer the read-model advances on.
DEFINE TABLE document_projection SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD scope_user_id ON document_projection TYPE string;
DEFINE FIELD doc_id ON document_projection TYPE string;
DEFINE FIELD title ON document_projection TYPE string DEFAULT '';
DEFINE FIELD body_preview ON document_projection TYPE string DEFAULT '';
DEFINE FIELD embedding ON document_projection TYPE option<array<float>>;
DEFINE FIELD embedding_model ON document_projection TYPE string DEFAULT 'unset';
DEFINE FIELD updated_cursor ON document_projection TYPE int;

-- One projection row per (scope, document); the server-derived scope_user_id is
-- the perimeter key and range-backs the scoped read of the read-model.
DEFINE INDEX idx_document_projection_scope_doc ON document_projection FIELDS scope_user_id, doc_id UNIQUE;

-- The RAG vector index: a native HNSW index over the model-tagged embedding so
-- retrieval is an index-backed KNN (the `<|K,EF|>` operator), never a full-scan.
-- DIMENSION is fixed per embedding space (the stub model's dimension); a single
-- index never mixes embedding spaces (the read filters embedding_model too).
DEFINE INDEX idx_document_projection_embedding ON document_projection FIELDS embedding HNSW DIMENSION 8 DIST COSINE TYPE F32;

-- The audit trail is APPEND-ONLY and SYSTEM-WRITTEN, carrying the full canonical
-- entry field set. Immutability and least-privilege are enforced at the row layer:
--
--   * FOR update, delete NONE holds for EVERY role including superadmin, so no
--     authenticated session — not even the highest tier — can rewrite, redact, or
--     clear an entry. The trail can only grow.
--   * FOR create is GATED to the admin/superadmin escalation, NOT left open (FULL).
--     Writes are system-level: the privileged forwarder that runs after the tRPC
--     authorization layer holds the write context (a root/system credential
--     bypasses row PERMISSIONS), and a below-admin scoped session can NEVER inject
--     a row. An arbitrary authenticated member session appending a forged event is
--     denied here — closing the audit-write fail-open at the data layer.
--   * FOR select is permitted only to the admin/superadmin tier, keyed on the
--     GLOBAL role claim $auth.role split on ',' (never an org-structural role), so
--     a non-admin session reads zero rows even if the tRPC layer were bypassed.
--
-- The COMMENT carries the machine-readable retention contract (retention_days) the
-- immutability conformance gate reads; a value under the 90-day floor reddens it.
DEFINE TABLE audit_log SCHEMAFULL
  COMMENT 'append-only system-written audit trail. retention_days=90'
  PERMISSIONS
    FOR create WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'
    FOR select WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'
    FOR update, delete NONE;

-- The action is constrained to the closed `<domain>.<verb>` vocabulary at the data
-- layer too (the Zod auditEntrySchema enforces the same at the write boundary): the
-- domain must be one of the closed set and a verb must follow the dot. A write with
-- an out-of-vocabulary action (e.g. 'billing.charge') is rejected by this ASSERT.
DEFINE FIELD action ON audit_log TYPE string
  ASSERT array::len(string::split($value, '.')) >= 2
    AND string::split($value, '.')[0] INSIDE ['auth', 'admin', 'session', 'lockout', 'user'];
-- The actor and the rest of the entry are supplied by the trusted system writer and
-- validated against the canonical shape at the write gate before they reach here;
-- the record id is a server-minted ULID (the idempotency key). Free-text fields
-- (actor_email / user_agent / ip) can carry arbitrary bytes and travel as bound
-- query variables on the write path, never spliced into the statement body.
DEFINE FIELD actor ON audit_log TYPE string;
DEFINE FIELD actor_email ON audit_log TYPE string;
DEFINE FIELD actor_role ON audit_log TYPE string;
DEFINE FIELD target_type ON audit_log TYPE string;
DEFINE FIELD target_id ON audit_log TYPE string;
DEFINE FIELD metadata ON audit_log TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD ip ON audit_log TYPE string;
DEFINE FIELD user_agent ON audit_log TYPE string;
-- Server-generated, immutable ISO-8601 timestamp (READONLY: never client-supplied,
-- never updatable). SurrealDB serializes the datetime to an ISO-8601 string on read.
DEFINE FIELD timestamp ON audit_log TYPE datetime DEFAULT time::now() READONLY;

-- Keyset read index: entries are read newest-first by the time-sortable ULID record
-- id (WHERE id > $cursor ORDER BY id LIMIT $n), never an OFFSET/START deep page. The
-- timestamp index backs range-scoped retention queries.
DEFINE INDEX idx_audit_log_timestamp ON audit_log FIELDS timestamp;

-- Break-glass recovery codes. The table is SEALED (PERMISSIONS NONE): no
-- record-access session — not even the code's owner — may read or mutate a row
-- directly. Generation and single-use consumption run in the privileged
-- system/superadmin-gated forwarder that bypasses row PERMISSIONS (mirroring the
-- audit-write path), so a scoped session can never read a hash, forge a code, or
-- flip `used_at`. Codes are stored ONLY as PBKDF2 hashes (never plaintext); a
-- consume marks `used_at` once, so a replayed/spent code can never be re-used.
DEFINE TABLE recovery_code SCHEMAFULL PERMISSIONS NONE;

-- The code hash (never the plaintext code). The spend timestamp is null until the
-- code is consumed single-use; the owning user reference scopes a user's set.
DEFINE FIELD hashed_code ON recovery_code TYPE string;
DEFINE FIELD used_at ON recovery_code TYPE option<datetime>;
DEFINE FIELD user_ref ON recovery_code TYPE record<user>;

-- Range-back the per-user recovery-code read (the consume scans a user's unused
-- codes); never a full-table scan.
DEFINE INDEX idx_recovery_code_user ON recovery_code FIELDS user_ref;
