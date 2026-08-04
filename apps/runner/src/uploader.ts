import type { AgentMessage, MessageBatchItem } from "@anvil/core";
import type { ApiClient } from "./client.js";

/** 上报前脱敏：把注入子进程的秘密值从消息里抹掉（spec §6）。 */
export function redact(m: AgentMessage, secrets: string[]): AgentMessage {
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const secret of secrets) if (secret) s = s.split(secret).join("***");
      return s;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = scrub(val);
      return out;
    }
    return v;
  };
  return { ...m, content: scrub(m.content) as any, input: scrub(m.input), output: scrub(m.output) as any };
}

/** 500ms 批量上报 + seq 连续编号 + 409 时按服务器 last_seq 重发。 */
export class MessageUploader {
  private buffer: MessageBatchItem[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: ApiClient,
    private taskId: string,
    private token: string,
    private secrets: string[],
    private flushMs = 500,
  ) {}

  push(m: AgentMessage) {
    this.buffer.push({ seq: this.seq++, ...redact(m, this.secrets) });
    if (!this.timer) this.timer = setTimeout(() => { this.flush().catch(() => {}); }, this.flushMs);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, 50);
      try {
        await this.client.appendMessages(this.taskId, this.token, batch);
        this.buffer.splice(0, batch.length);
      } catch (e: any) {
        if (e?.status === 409 && typeof e.body?.last_seq === "number") {
          const before = this.buffer.length;
          this.buffer = this.buffer.filter((m) => m.seq > e.body.last_seq);
          if (this.buffer.length === before) {
            // 护栏：server last_seq 比 buffer 头部还旧（当前不可达），防热死循环
            console.error("[anvil-uploader] 409 resync made no progress, dropping buffered messages");
            break;
          }
          continue;
        }
        throw e;
      }
    }
  }

  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}
