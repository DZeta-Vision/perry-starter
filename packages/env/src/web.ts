import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>;

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    // Client-readable build-time target selector. A bare PERRY_TARGET is
    // server-only and reads undefined in the browser; the VITE_ prefix is what
    // exposes the selector to client source.
    VITE_PERRY_TARGET: z.enum(["local-sidecar", "cloud-relay"]),
  },
  runtimeEnv: (import.meta as ImportMeta & { env: ImportMetaEnvRecord }).env,
  emptyStringAsUndefined: true,
});
