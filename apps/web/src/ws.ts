import { useEffect } from "react";
import type { ServerEvent } from "@anvil/core";

/** 订阅 server 事件流；断线 3s 重连。 */
export function useServerEvents(onEvent: (e: ServerEvent) => void) {
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) setTimeout(connect, 3000); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, []);
}
