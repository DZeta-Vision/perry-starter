import { z } from "zod";
import { isoTimestamp, ulidId } from "../primitives";

// Lowercase `<domain>.<verb>` action vocabulary. Top-level literal — never built
// inside a loop. The domain is one of the closed set; the verb is lowercase
// snake_case.
const AUDIT_ACTION = /^(auth|admin|session|lockout|user)\.[a-z][a-z0-9_]*$/;

// The append-only audit entry carries the full normative field set. strictObject
// enforces the exact shape so the field set cannot drift.
export const auditEntrySchema = z.strictObject({
  id: ulidId,
  action: z.string().regex(AUDIT_ACTION),
  actor: z.string().min(1),
  actor_email: z.email(),
  actor_role: z.string().min(1),
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  ip: z.string().min(1),
  user_agent: z.string().min(1),
  timestamp: isoTimestamp,
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
