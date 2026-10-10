import { parseArgs } from "node:util";
import { readR2Inventory } from "./r2-inventory.js";

try {
  const { values } = parseArgs({ options: {
    db: { type: "string" }, since: { type: "string" }, task: { type: "string", multiple: true },
  } });
  if (!values.db || !values.since) throw new Error("缺少参数");
  console.log(JSON.stringify(readR2Inventory(values.db, values.since, values.task), null, 2));
} catch {
  // 不打印可能含本地路径/SQL/参数正文的底层错误。
  console.error("R2 盘点失败。用法：pnpm --filter @anvil/server r2:inventory --db <已有 SQLite 路径> --since <UTC ISO 时间> [--task <Task ID>]。请检查数据库、表结构、采集时间和参数。");
  process.exitCode = 1;
}
