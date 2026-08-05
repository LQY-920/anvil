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
  // 容忍"带 content-type: application/json 但 body 为空"的请求（默认解析器会 400），
  // 无 body 的 POST（merge/cancel/rerun 等）应能到达路由
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
    try { done(null, JSON.parse(body)); }
    catch (e: any) { e.statusCode = 400; done(e); }
  });
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
  const { registerReviewRoutes } = await import("./routes/review.js");
  registerReviewRoutes(app, db, hub);

  const { sweepOfflineRuntimes } = await import("./services/runtimes.js");
  const { sweepExpiredLeases, getTask } = await import("./services/tasks.js");
  const sweepTimer = setInterval(() => {
    try { sweepOfflineRuntimes(db, new Date().toISOString()); }
    catch (e) { app.log.error(e, "sweepOfflineRuntimes failed"); }
    try {
      for (const id of sweepExpiredLeases(db, new Date().toISOString()))
        hub.broadcast({ type: "task.updated", data: getTask(db, id) });
    }
    catch (e) { app.log.error(e, "sweepExpiredLeases failed"); }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweepTimer));
  return app;
}
