import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, Trash2, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { Button } from "../../components/ui/button";

export function DncPage() {
  const queryClient = useQueryClient();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["dnc"],
    queryFn: async () => {
      const res = await api.voice.dnc.$get({}, { headers: adminHeaders() });
      return res.json();
    },
  });

  const add = useMutation({
    mutationFn: async () => {
      const res = await api.voice.dnc.$post(
        { json: { phoneNumber, reason: reason || undefined } },
        { headers: adminHeaders() },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setPhoneNumber("");
      setReason("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["dnc"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: async (phone: string) => {
      await api.voice.dnc[":phoneNumber"].$delete(
        { param: { phoneNumber: encodeURIComponent(phone) } },
        { headers: adminHeaders() },
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dnc"] }),
  });

  const dncRows = list.data && "doNotCall" in list.data ? list.data.doNotCall : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldOff className="size-5 text-primary" />
          Do Not Call list
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Checked automatically before every outbound call via <code className="font-mono text-xs">@weeber/compliance</code>.
          Numbers land here manually (below) or automatically when the agent records a "not-interested" disposition.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="flex flex-col sm:flex-row gap-2 mb-8"
      >
        <input
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="+15551234567"
          aria-label="Phone number"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring/40"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          aria-label="Reason"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
        <Button
          type="submit"
          disabled={!phoneNumber || add.isPending}
        >
          <Plus className="size-4 mr-1" />
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive -mt-6 mb-6">{error}</p>}

      <div className="card-weeber divide-y divide-border">
        {dncRows.map((entry) => (
          <div key={entry.phoneNumber} className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-mono text-sm">{entry.phoneNumber}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {entry.source}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => remove.mutate(entry.phoneNumber)}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${entry.phoneNumber} from Do Not Call list`}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {dncRows.length === 0 && (
          <div className="px-4 py-8 text-sm text-muted-foreground text-center">No numbers on the list.</div>
        )}
      </div>
    </div>
  );
}
