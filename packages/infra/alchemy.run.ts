import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });

const app = await alchemy("perry-starter");

export const web = await TanStackStart("web", {
  cwd: "../../apps/web",
  // The web worker's SSR validates the full shared server env contract eagerly
  // at boot, so every required var must be bound here or the worker 500s with
  // "Invalid environment variables". (A future refinement may make SURREAL_*
  // conditionally required by PERRY_TARGET — the cloud-relay worker reaches the
  // data store through the gatekeeper, not via these creds directly.)
  bindings: {
    PERRY_TARGET: alchemy.env.PERRY_TARGET,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN,
    BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL,
    SURREAL_URL: alchemy.env.SURREAL_URL,
    SURREAL_NS: alchemy.env.SURREAL_NS,
    SURREAL_DB: alchemy.env.SURREAL_DB,
    SURREAL_USER: alchemy.secret.env.SURREAL_USER,
    SURREAL_PASS: alchemy.secret.env.SURREAL_PASS,
  },
});

console.log(`Web    -> ${web.url}`);

await app.finalize();
