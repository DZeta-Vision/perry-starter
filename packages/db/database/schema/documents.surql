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

DEFINE INDEX user_email ON user FIELDS email UNIQUE;

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

-- The audit trail is APPEND-ONLY. Entries may be created, and read only by the
-- admin/superadmin tier (the escalation is keyed on the GLOBAL role claim
-- $auth.role split on ',', never an org-structural role). NO role — not even
-- superadmin — may update or delete an entry: FOR update, delete NONE holds for
-- everyone, so the trail can never be rewritten. The escalation predicate here is
-- the one the row-PERMISSIONS generator emits from the single-sourced matrix.
DEFINE TABLE audit_log SCHEMAFULL
  PERMISSIONS
    FOR create FULL
    FOR select WHERE string::split($auth.role, ',') CONTAINS 'admin' OR string::split($auth.role, ',') CONTAINS 'superadmin'
    FOR update, delete NONE;

DEFINE FIELD action ON audit_log TYPE string;
-- actor_id is the AUTHENTICATED writer, never client-supplied: VALUE recomputes
-- it from the session's $auth on every write, so a forged actor_id in the create
-- payload is overwritten by type::string($auth) (the record-access user's id).
-- This closes the write-authenticity hole that a plain DEFAULT '' left open while
-- keeping the trail append-only (FOR update, delete NONE above).
DEFINE FIELD actor_id ON audit_log TYPE string VALUE type::string($auth);
DEFINE FIELD created_at ON audit_log TYPE datetime DEFAULT time::now() READONLY;
