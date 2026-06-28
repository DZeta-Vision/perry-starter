import { createDocumentsLocal } from "@perry-starter/data";
import fastify, { type FastifyInstance } from "fastify";

// The daemon's single minimal read route through the local data seam. It lifts
// the seam's local implementation (CRUD over the loopback `surreal` sidecar via
// native fetch) and returns canonical, Zod-parsed `documents` rows — proving the
// shell reads the store THROUGH the seam, not a hard-coded stub. The full
// tRPC/server-route lift and the auth-gated surface are out of scope here.

export interface DocumentsReadConfig {
  readonly db: string;
  readonly ns: string;
  // A scoped record-access identity to read under. When omitted the seam
  // provisions a per-instance local identity on first use.
  readonly session?: { readonly email: string; readonly pass: string };
  readonly url: string;
}

export const registerDocumentsRead = (
  app: FastifyInstance,
  config: DocumentsReadConfig
): void => {
  const documents = createDocumentsLocal({
    url: config.url,
    ns: config.ns,
    db: config.db,
    session: config.session,
  });

  app.get("/api/documents", async (_request, reply) => {
    const rows = await documents.list();
    reply.type("application/json").send(JSON.stringify(rows));
  });
};

export const createDocumentsReadApp = (
  config: DocumentsReadConfig
): FastifyInstance => {
  const app = fastify();
  registerDocumentsRead(app, config);
  return app;
};
