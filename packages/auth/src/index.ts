import { env } from "@perry-starter/env/server";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";

export const auth = betterAuth({
  // TODO: wire the SurrealDB better-auth adapter, driven by the SURREAL_*
  // contract from @perry-starter/env/server. Until then better-auth constructs
  // without an explicit database; the legacy DATABASE_URL is intentionally gone.
  trustedOrigins: [env.CORS_ORIGIN],
  emailAndPassword: {
    enabled: true,
  },
  plugins: [organization(), tanstackStartCookies()],
});
