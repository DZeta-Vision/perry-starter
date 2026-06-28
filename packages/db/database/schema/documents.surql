-- Merged local data-engine schema for the documents entity.
--
-- Driven over SurrealDB's HTTP API only. Every user-data table declares explicit
-- row-level PERMISSIONS scoped to the authenticated record ($auth) so that a
-- scoped, non-root session can never read or mutate another owner's rows. The
-- bootstrap root credential is used for this DDL only; per-request queries run
-- through a scoped record-access session whose $auth is the matched user record.

-- Record-access perimeter: a per-session credential whose $auth is a user record
-- (not a coarse system user). Sign-up registers a user; sign-in authenticates an
-- existing one. The unique email index makes registration idempotent.
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET email = $email, pass = crypto::argon2::generate($pass) )
  SIGNIN ( SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(pass, $pass) )
  DURATION FOR TOKEN 18m, FOR SESSION 12h;

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
-- server-side later; here it is only shaped as fully denied.
DEFINE TABLE document_delta SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD scope_user_id ON document_delta TYPE string;
DEFINE FIELD doc_id ON document_delta TYPE string;
DEFINE FIELD cursor ON document_delta TYPE int;
DEFINE FIELD payload ON document_delta TYPE string;
