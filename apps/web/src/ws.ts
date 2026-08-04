import { useEffect, useRef } from "react";
import type { ServerEvent } from "@anvil/core";

/** 订阅 server 事件流；断线 3s 重连。回调经 ref 持有，永远调最新版本，无 stale closure。 */
export function useServerEvents(onEvent: (e: ServerEvent) => void) {
  const cbRef = useRef(onEvent);
  useEffect(() => { cbRef.current = onEvent; });
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => { try { cbRef.current(JSON.parse(ev.data)); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) reconnectTimer = setTimeout(connect, 3000); };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);
}
