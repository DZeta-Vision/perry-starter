import { z } from "zod";

// The canonical persisted break-glass recovery-code row. snake_case fields: the
// code hash (never the plaintext code), the single-use spend timestamp (null until
// consumed), and the owning user reference. strictObject pins the exact shape so a
// plaintext-code field can never be added by drift.
export const recoveryCodeSchema = z.strictObject({
  hashed_code: z.string().min(1),
  used_at: z.string().nullable(),
  user_ref: z.string().min(1),
});

export type RecoveryCode = z.infer<typeof recoveryCodeSchema>;
