import { useEffect, useRef, useState } from "react";
import { API_BASE_URL, apiUrl } from "./api";

/**
 * Live waitlist count for the landing page — WebSocket push with
 * exponential backoff reconnect, HTTP fallback for the very first paint
 * (before the socket has had a chance to connect) so the number isn't
 * blank while that happens. Ported from Vocalist's waitlist (see
 * DECISIONS.md ADR-041) — adapted to this repo's same-origin/split-deploy
 * seam (`API_BASE_URL`, see lib/api.ts) instead of a separate `VITE_WS_HOST`.
 */
export function useWaitlistCount() {
  const [count, setCount] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);

  useEffect(() => {
    let unmounted = false;

    // First paint — plain HTTP GET, independent of whether the socket ever
    // connects (some networks block WS but allow HTTPS fine).
    fetch(apiUrl("/api/public/waitlist/count"))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!unmounted && typeof data?.count === "number") setCount(data.count);
      })
      .catch(() => {
        // Non-fatal — the WS connection below still gets a chance to set it.
      });

    function connect() {
      if (unmounted) return;
      const base = API_BASE_URL || window.location.origin;
      const wsUrl = base.replace(/^http/, "ws") + "/api/public/waitlist/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "waitlist_count" && typeof data.count === "number") setCount(data.count);
        } catch {
          // Ignore malformed frames — the count just doesn't update this tick.
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
        retriesRef.current++;
        setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      unmounted = true;
      wsRef.current?.close();
    };
  }, []);

  return { count };
}
