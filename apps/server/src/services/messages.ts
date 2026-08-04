import { newId, type Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import type { MessageBatchItem } from "@anvil/core";

export function lastSeq(db: Db, taskId: string): number {
  const row = db.$client.prepare(`SELECT MAX(seq) AS m FROM task_messages WHERE task_id = ?`).get(taskId) as any;
  return row?.m ?? -1;
}

/** 落库一批消息；seq 必须从 last_seq+1 连续，否则返回冲突让 runner 重发。 */
export function appendTaskMessages(
  db: Db, hub: Hub, taskId: string, items: MessageBatchItem[],
): { ok: true; last_seq: number } | { ok: false; last_seq: number } {
  if (items.length === 0) return { ok: true, last_seq: lastSeq(db, taskId) };
  const expected = lastSeq(db, taskId) + 1;
  if (items[0].seq !== expected) return { ok: false, last_seq: expected - 1 };
  const insert = db.$client.prepare(
    `INSERT INTO task_messages (id, task_id, seq, type, tool, content, input_json, output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const tx = db.$client.transaction((rows: MessageBatchItem[]) => {
    let seq = expected;
    for (const m of rows) {
      if (m.seq !== seq) throw new Error("seq gap within batch");
      insert.run(newId(), taskId, m.seq, m.type, m.tool ?? null, m.content ?? null,
        m.input !== undefined ? JSON.stringify(m.input) : null,
        m.output !== undefined ? String(m.output) : null, now);
      seq++;
    }
  });
  tx(items);
  for (const m of items) hub.broadcast({ type: "task.message", data: { task_id: taskId, ...m } });
  return { ok: true, last_seq: expected + items.length - 1 };
}

export function listMessages(db: Db, taskId: string, afterSeq: number) {
  return db.$client
    .prepare(`SELECT seq, type, tool, content, input_json, output, created_at FROM task_messages
              WHERE task_id = ? AND seq > ? ORDER BY seq ASC`)
    .all(taskId, afterSeq);
}
