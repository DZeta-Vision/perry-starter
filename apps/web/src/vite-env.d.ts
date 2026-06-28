// Types the client-readable build-time target selector. The seam selects the
// data/AI implementation at build time; this only makes the inlined selector
// strongly typed in client source (augments vite/client's ImportMetaEnv, which
// is already pulled in via this app's tsconfig `types`).
interface ImportMetaEnv {
  readonly VITE_PERRY_TARGET: "local-sidecar" | "cloud-relay";
}
