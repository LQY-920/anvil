import { buildApp } from "./app.js";

const port = Number(process.env.ANVIL_PORT ?? 3100);
const dbPath = process.env.ANVIL_DB ?? "anvil.db";

const app = await buildApp({ dbPath });
await app.listen({ port, host: "127.0.0.1" });
console.log(`anvil server listening on http://127.0.0.1:${port}`);
