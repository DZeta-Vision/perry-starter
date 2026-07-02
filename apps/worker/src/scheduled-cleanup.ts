import {
  buildCleanupInvitationExpiryAudit,
  buildCleanupObservationAudit,
  buildCleanupSoftDeleteAudit,
  buildCleanupSoftDeleteSql,
  buildExpiredPendingInvitationSelectSql,
  buildExpireInvitationSql,
  buildUnverifiedCandidateSelectSql,
  type CleanupAccountCandidate,
  type CleanupInvitationCandidate,
  type CleanupResult,
  cleanupIsSystemAuthorized,
  mintAuditUlid,
  resolveCleanupConfig,
  runCleanupPass,
} from "@perry-starter/api/scheduled-cleanup";
import { type SurrealAuth, sql } from "@perry-starter/data/surreal-http";

// The scheduled, observe-first, soft-delete cleanup handler — it runs on the
// gatekeeper Worker (the ONE server unit that reaches cloud SurrealDB), triggered
// by the cron on the same Worker. It is SESSIONLESS: its authorizing identity is
// the trusted system principal the append-only audit-write gate recognizes, and
// it reaches cloud data ONLY through the single post-auth forwarder (the
// gatekeeper's runtime SURREAL_* binding) — never a raw credential that skips the
// authorization layer. All the safety policy (observe-first, protected-account
// exclusion, soft-delete-only, window default, mode toggle) lives in the shared,
// fully-tested @perry-starter/api policy; this file is thin store wiring.

export interface CleanupEnv {
  // The observe/sweep toggle (default observe) and the window in hours (default
  // 48) — resolved with an observe-first posture by the shared policy.
  readonly CLEANUP_MODE?: string;
  readonly CLEANUP_WINDOW_HOURS?: string;
  readonly SURREAL_DB: string;
  readonly SURREAL_NS: string;
  readonly SURREAL_PASS: string;
  readonly SURREAL_URL: string;
  readonly SURREAL_USER: string;
}

// Revoke every session for a soft-deleted account — the cascade. Deleting the
// session rows is revocation (the account row itself is only soft-flipped, never
// deleted).
const SESSION_REVOKE_SQL = "DELETE session WHERE userId = $uid;";

// The scheduled entrypoint: wire the store forwarders and run one pass. Returns
// the pass result (counts + identifiers) so a caller/log can surface it.
export const handleScheduledCleanup = async (
  env: CleanupEnv
): Promise<CleanupResult> => {
  // Fail closed: the sessionless job must resolve to the trusted system principal
  // (and a below-admin session must NOT). If that authority ever fails to hold,
  // do not run.
  if (!cleanupIsSystemAuthorized()) {
    throw new Error("scheduled cleanup could not resolve its system authority");
  }

  const now = Date.now();
  const { mode, windowHours } = resolveCleanupConfig(env);

  // The single post-auth forwarder: the runtime system credential bound on THIS
  // gatekeeper Worker, reached over SurrealDB-over-HTTP via native fetch.
  const auth: SurrealAuth = {
    kind: "basic",
    user: env.SURREAL_USER,
    pass: env.SURREAL_PASS,
  };
  const forward = (query: string, vars?: Record<string, string>) =>
    sql(env.SURREAL_URL, env.SURREAL_NS, env.SURREAL_DB, auth, query, vars);

  const loadUnverifiedCandidates = async (): Promise<
    readonly CleanupAccountCandidate[]
  > => {
    const select = buildUnverifiedCandidateSelectSql({ now, windowHours });
    const rows = await forward(select.query, select.vars);
    return (rows[0]?.result ?? []) as CleanupAccountCandidate[];
  };

  const loadExpiredPendingInvitations = async (): Promise<
    readonly CleanupInvitationCandidate[]
  > => {
    const select = buildExpiredPendingInvitationSelectSql({ now });
    const rows = await forward(select.query, select.vars);
    return (rows[0]?.result ?? []) as CleanupInvitationCandidate[];
  };

  return await runCleanupPass({
    mode,
    now,
    windowHours,
    loadUnverifiedCandidates,
    loadExpiredPendingInvitations,
    softDeleteAccount: async (userId) => {
      const flip = buildCleanupSoftDeleteSql(userId);
      await forward(flip.query, flip.vars);
    },
    revokeAccountSessions: async (userId) => {
      await forward(SESSION_REVOKE_SQL, { uid: userId });
    },
    expireInvitation: async (invitationId) => {
      const flip = buildExpireInvitationSql(invitationId);
      await forward(flip.query, flip.vars);
    },
    recordObservation: async (plan) => {
      const audit = buildCleanupObservationAudit(mintAuditUlid(now), plan);
      await forward(audit.query, audit.vars);
    },
    recordSoftDelete: async (event) => {
      const audit = buildCleanupSoftDeleteAudit(
        mintAuditUlid(now),
        event.target
      );
      await forward(audit.query, audit.vars);
    },
    recordInvitationExpiry: async (event) => {
      const audit = buildCleanupInvitationExpiryAudit(
        mintAuditUlid(now),
        event.target
      );
      await forward(audit.query, audit.vars);
    },
  });
};
