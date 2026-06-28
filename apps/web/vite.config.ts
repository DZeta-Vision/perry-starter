import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defaultClientConditions, defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Build-time runtime-target seam: PERRY_TARGET selects the data/AI implementation
// by adding a per-target resolution condition so the seam packages' conditional
// exports resolve *.local.ts vs *.cloud.ts and physically exclude the unselected
// implementation — never via a runtime branch. Read at config time from the
// build environment; defaults to the local-sidecar target.
const perryTargetCondition =
  process.env.PERRY_TARGET === "cloud-relay" ? "perry-cloud" : "perry-local";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    alchemy(),
  ],
  resolve: {
    conditions: [perryTargetCondition, ...defaultClientConditions],
  },
  server: {
    port: 3001,
  },
  ssr: {
    noExternal: ["better-auth"],
  },
});
