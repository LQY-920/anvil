import type { WebSocket } from "ws";
import type { ServerEvent } from "@anvil/core";

/** 极简连接池：web 端 WS 订阅 + server 内广播。runner hint 通道复用同一池（按 kind 区分）。 */
export class Hub {
  private webSockets = new Set<WebSocket>();
  private daemonSockets = new Set<WebSocket>();

  addWeb(ws: WebSocket) { this.webSockets.add(ws); ws.on("close", () => this.webSockets.delete(ws)); }
  addDaemon(ws: WebSocket) { this.daemonSockets.add(ws); ws.on("close", () => this.daemonSockets.delete(ws)); }

  broadcast(event: ServerEvent) {
    const raw = JSON.stringify(event);
    for (const ws of this.webSockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  }

  /** 给 runner 的"有活了"轻提示；丢了无害。 */
  hintDaemons(event: ServerEvent) {
    const raw = JSON.stringify(event);
    for (const ws of this.daemonSockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}
