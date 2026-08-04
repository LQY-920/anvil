import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { createDb, runMigrations, seed, type Db } from "./db/client.js";
import { Hub } from "./ws/hub.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerMetaRoutes } from "./routes/meta.js";

declare module "fastify" {
  interface FastifyInstance { db: Db; hub: Hub; }
}

export interface BuildAppOptions { dbPath: string; logger?: boolean; }

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const db = createDb(opts.dbPath);
  runMigrations(db);
  seed(db);
  const hub = new Hub();
  app.decorate("db", db);
  app.decorate("hub", hub);

  await app.register(websocket);
  app.get("/ws", { websocket: true }, (socket) => { hub.addWeb(socket); });

  registerMetaRoutes(app, db);
  registerIssueRoutes(app, db, hub);
  const { registerDaemonRoutes } = await import("./routes/daemon.js");
  registerDaemonRoutes(app, db, hub);
  const { registerTaskRoutes } = await import("./routes/tasks.js");
  registerTaskRoutes(app, db, hub);

  const { sweepOfflineRuntimes } = await import("./services/runtimes.js");
  const { sweepExpiredLeases } = await import("./services/tasks.js");
  const sweepTimer = setInterval(() => {
    try {
      sweepOfflineRuntimes(db, new Date().toISOString());
      sweepExpiredLeases(db, new Date().toISOString());
    } catch (e) { app.log.error(e, "sweep failed"); }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweepTimer));
  return app;
}
