import { env } from "@perry-starter/env/server";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";

export const auth = betterAuth({
  database: env.DATABASE_URL,
  trustedOrigins: [env.CORS_ORIGIN],
  emailAndPassword: {
    enabled: true,
  },
  plugins: [organization(), tanstackStartCookies()],
});
