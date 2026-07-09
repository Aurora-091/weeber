import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { getAdminKey, setAdminKey, adminHeaders } from "../../lib/admin-key";
import { apiFetch } from "../../lib/api";

/**
 * Gates dashboard access behind the same ADMIN_API_KEY used by ops
 * endpoints (see api/voice/middleware/admin-auth.ts). Verifies the key by
 * calling a real admin-gated route (GET /api/voice/calls) rather than just
 * trusting whatever's in sessionStorage — a stale/rotated key is caught
 * immediately instead of silently 401ing on every request underneath.
 */
export function AdminKeyGate({ children }: { children: ReactNode }) {
  const [input, setInput] = useState(getAdminKey());
  const [attempted, setAttempted] = useState(getAdminKey().length > 0);

  const check = useQuery({
    queryKey: ["admin-key-check", attempted ? getAdminKey() : null],
    queryFn: async () => {
      // Plain fetch rather than the typed RPC client here — this check only
      // cares about the HTTP status, not the response shape, and sidesteps a
      // TS inference quirk on this particular route's generated client type.
      const res = await apiFetch("/api/voice/calls", { headers: adminHeaders() });
      if (res.status === 401) throw new Error("unauthorized");
      if (!res.ok) throw new Error(`unexpected status ${res.status}`);
      return true;
    },
    enabled: attempted,
    retry: false,
  });

  if (attempted && check.isSuccess) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 text-ember mb-4">
          <KeyRound className="size-5" />
          <span className="font-mono text-xs uppercase tracking-[0.2em]">Admin access required</span>
        </div>
        <h1 className="text-2xl font-semibold font-[family-name:var(--font-display)] mb-2">
          Enter your admin key
        </h1>
        <p className="text-sm text-ink-soft mb-6">
          This matches <code className="font-mono text-xs bg-paper-2 px-1.5 py-0.5 rounded">ADMIN_API_KEY</code> in
          your server's <code className="font-mono text-xs bg-paper-2 px-1.5 py-0.5 rounded">.env</code>. Stored only
          in this tab's session storage.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAdminKey(input);
            setAttempted(true);
            check.refetch();
          }}
          className="flex flex-col gap-3"
        >
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Admin key"
            aria-label="Admin key"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ember/40"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-ember text-paper px-4 py-2 text-sm font-medium hover:bg-ember/90 transition-colors"
          >
            Unlock dashboard
          </button>
          {attempted && check.isError && (
            <p className="text-sm text-destructive">Invalid key — check ADMIN_API_KEY in your server's .env.</p>
          )}
        </form>
      </div>
    </div>
  );
}
