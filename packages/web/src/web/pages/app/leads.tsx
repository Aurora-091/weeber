import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Loader as Loader2, Search, Download, Plus, ShieldAlert, UserRound, SlidersHorizontal, Trash2, Share2, RefreshCw, CircleAlert as AlertCircle, KeyRound, Copy, Check, Link2 } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { apiUrl } from "../../lib/api";
import { wwwUrl } from "../../lib/domains";
import { useCopy } from "../../lib/useCopy";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { formatRelative } from "../../lib/format";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";

// Mirrors the backend's leads layer (voice/leads/*, native-leads-layer-plan).
// The person-of-record for a vertical. This page is the insurance "Leads"
// projection; Shopify's "Orders" migrates onto the same layer in Phase 3.

type LeadStatus = "new" | "contacted" | "qualified" | "booked" | "closed" | "lost";
type LeadSource = "call" | "form" | "webhook" | "pipedream" | "crm" | "manual";

type FieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "enum" | "boolean" | "date";
  required?: boolean;
  options?: string[];
  piiClass?: string;
};

type LeadRow = {
  id: number;
  phone: string;
  name: string | null;
  fields: Record<string, string>;
  status: LeadStatus;
  source: LeadSource;
  assignedAdvisorId: number | null;
  firstSeenAt: string;
  lastActivityAt: string;
};

type LeadCall = {
  id: number;
  direction: string;
  status: string;
  disposition: string | null;
  sentiment: string | null;
  intent: string | null;
  startedAt: string;
  endedAt: string | null;
  // ADR-120: entries are `{ value, heard, transcriptId, turn }` objects now;
  // read them through `capturedValue` rather than as bare strings.
  capturedState: Record<string, unknown> | null;
};

type Advisor = { id: number; name: string; npn: string | null; licensedStates: string[] };

const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "booked", "closed", "lost"];

const STATUS_VARIANT: Record<LeadStatus, "default" | "secondary" | "destructive" | "outline"> = {
  new: "outline",
  contacted: "secondary",
  qualified: "secondary",
  booked: "default",
  closed: "default",
  lost: "destructive",
};

const SOURCE_LABEL: Record<LeadSource, string> = {
  call: "Call",
  form: "Form",
  webhook: "Webhook",
  pipedream: "Pipedream",
  crm: "CRM",
  manual: "Manual",
};

const UNASSIGNED = "__unassigned__";

type LeadApiKeyRow = {
  id: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function formatWhen(iso: string | null) {
  return formatRelative(iso as string);
}

export function UserLeadsPage() {
  const { me } = useUser();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [openLeadId, setOpenLeadId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);

  const leads = useQuery<{ leads: LeadRow[] }>({
    queryKey: ["app-leads", query.trim()],
    queryFn: async () => {
      const res = await appFetch(`/api/app/leads${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: 20000,
  });

  const schema = useQuery<{ fields: FieldDef[]; isCustom: boolean }>({
    queryKey: ["app-leads-schema"],
    queryFn: async () => {
      const res = await appFetch("/api/app/leads/intake-schema");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const advisors = useQuery<{ advisors: Advisor[] }>({
    queryKey: ["app-insurance-advisors"],
    queryFn: async () => {
      const res = await appFetch("/api/app/insurance-advisors");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/export/leads.xlsx");
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return res.blob();
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "leads.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Leads exported");
    },
    onError: () => toast.error("Couldn't export leads — try again."),
  });

  const fields = schema.data?.fields ?? [];
  const advisorList = advisors.data?.advisors ?? [];
  const rows = leads.data?.leads ?? [];

  return (
    <div className="page-enter">
      <PageHeader
        title="Leads"
        description="Every person who's entered your pipeline — from agent calls, forms, or your CRM. One record per contact, deduped by phone. Assign an advisor, move them through the pipeline, or call them right now."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setSchemaOpen(true)}
            >
              <SlidersHorizontal className="size-3.5" aria-hidden />
              Configure fields
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={exportMutation.isPending || rows.length === 0}
              onClick={() => exportMutation.mutate()}
            >
              {exportMutation.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
              Export
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
              <Plus className="size-3.5" aria-hidden />
              Add lead
            </Button>
          </>
        }
      />

      <LeadCaptureSection orgId={me.org.id} />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or phone..."
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      </div>

      {leads.isLoading && <SkeletonTable rows={6} />}
      {leads.isError && (
        <EmptyState
          title="Couldn't load leads"
          description="Something went wrong reaching the server. Check your connection and try again."
          icon={AlertCircle}
          action={
            <Button size="sm" variant="outline" onClick={() => leads.refetch()}>
              <RefreshCw className="size-3.5" aria-hidden />
              Retry
            </Button>
          }
        />
      )}
      {!leads.isLoading && !leads.isError && rows.length === 0 && (
        <EmptyState
          title={query.trim() ? "No matches" : "No leads yet"}
          description={
            query.trim()
              ? "Try a different search."
              : "Leads show up here as your agents finish calls, or when a form/CRM sends them in. You can also add one manually."
          }
        />
      )}

      {rows.length > 0 && (
        <div className="card-weeber content-fade-in divide-y divide-border overflow-hidden">
          {rows.map((row) => {
            const advisor = advisorList.find((a) => a.id === row.assignedAdvisorId);
            return (
              <button
                key={row.id}
                onClick={() => setOpenLeadId(row.id)}
                className="flex w-full flex-wrap items-center gap-4 px-5 py-shell-row text-left transition-colors hover:bg-muted/40"
              >
                <div className="min-w-[12rem] flex-1">
                  <div className="text-sm font-medium">{row.name || "Unnamed lead"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{row.phone}</div>
                </div>
                <Badge variant="outline" className="text-xs">{SOURCE_LABEL[row.source]}</Badge>
                <Badge variant={STATUS_VARIANT[row.status]} className="capitalize">{row.status}</Badge>
                <div className="hidden w-40 shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <UserRound className="size-3.5" aria-hidden />
                  {advisor ? advisor.name : "Unassigned"}
                </div>
                <div className="hidden w-32 shrink-0 text-xs text-muted-foreground md:block">{formatWhen(row.lastActivityAt)}</div>
              </button>
            );
          })}
        </div>
      )}

      <LeadDetailSheet
        leadId={openLeadId}
        onClose={() => setOpenLeadId(null)}
        fields={fields}
        advisors={advisorList}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["app-leads"] })}
      />

      <AddLeadDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        fields={fields}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["app-leads"] })}
      />

      <SchemaEditorDialog
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        fields={fields}
        isCustom={schema.data?.isCustom ?? false}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["app-leads-schema"] });
          queryClient.invalidateQueries({ queryKey: ["app-leads"] });
        }}
      />
    </div>
  );
}

function LeadCaptureSection({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const { copy, copied } = useCopy({ message: "Copied to clipboard" });
  const [label, setLabel] = useState("");
  const [justCreated, setJustCreated] = useState<{ label: string; key: string } | null>(null);
  const hostedFormUrl = wwwUrl(`/f/${orgId}`);
  const ingestUrl = apiUrl("/api/leads/ingest");

  const keys = useQuery<{ keys: LeadApiKeyRow[] }>({
    queryKey: ["app-leads-api-keys"],
    queryFn: async () => {
      const res = await appFetch("/api/app/leads/api-keys");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const createKey = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/leads/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      return res.json() as Promise<{ id: number; label: string; key: string }>;
    },
    onSuccess: (data) => {
      setJustCreated({ label: data.label, key: data.key });
      setLabel("");
      queryClient.invalidateQueries({ queryKey: ["app-leads-api-keys"] });
      toast.success("Ingest key created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeKey = useMutation({
    mutationFn: async (id: number) => {
      const res = await appFetch(`/api/app/leads/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-leads-api-keys"] });
      toast.success("Key revoked");
    },
    onError: () => toast.error("Couldn't revoke key — try again."),
  });

  const activeKeys = (keys.data?.keys ?? []).filter((k) => !k.revokedAt);

  return (
    <section className="card-weeber mb-6 space-y-6 p-5">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Share2 className="size-4 text-primary" aria-hidden />
          Capture sources
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Share your hosted form or send leads from a CRM, Zapier, or custom integration using an ingest API key.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="size-3.5 text-muted-foreground" aria-hidden />
          Hosted form
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 min-w-[12rem] rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono break-all">
            {hostedFormUrl}
          </code>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => copy(hostedFormUrl)}>
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            Copy link
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
          Ingest API keys
        </div>
        <p className="text-xs text-muted-foreground max-w-2xl">
          POST JSON to <code className="font-mono">{ingestUrl}</code> with{" "}
          <code className="font-mono">Authorization: Bearer wlk_…</code> (or <code className="font-mono">X-Api-Key</code>).
          Keys are org-scoped and revocable — safe to hand to a client form or Pipedream.
        </p>

        {justCreated && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium mb-2">
              New key for &ldquo;{justCreated.label}&rdquo; — copy it now, it won&apos;t be shown again:
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 min-w-[12rem] text-xs font-mono bg-card border border-border rounded px-3 py-2 overflow-x-auto">
                {justCreated.key}
              </code>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => copy(justCreated.key)}>
                <Copy className="size-3.5" aria-hidden />
                Copy key
              </Button>
            </div>
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            createKey.mutate();
          }}
        >
          <div className="min-w-[12rem] flex-1 space-y-1">
            <Label htmlFor="lead-key-label" className="text-xs">Label</Label>
            <Input
              id="lead-key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Website form"
              className="h-9"
            />
          </div>
          <Button type="submit" size="sm" disabled={!label.trim() || createKey.isPending}>
            {createKey.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            Create key
          </Button>
        </form>

        {keys.isLoading && <p className="text-xs text-muted-foreground">Loading keys…</p>}
        {keys.isError && (
          <p className="text-xs text-destructive">Couldn&apos;t load API keys.</p>
        )}
        {activeKeys.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {activeKeys.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{row.label}</div>
                  <div className="text-xs text-muted-foreground">
                    Created {formatWhen(row.createdAt)}
                    {row.lastUsedAt ? ` · Last used ${formatWhen(row.lastUsedAt)}` : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={revokeKey.isPending}
                  onClick={() => revokeKey.mutate(row.id)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function LeadDetailSheet({
  leadId,
  onClose,
  fields,
  advisors,
  onChanged,
}: {
  leadId: number | null;
  onClose: () => void;
  fields: FieldDef[];
  advisors: Advisor[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();

  const detail = useQuery<{ lead: LeadRow; calls: LeadCall[] }>({
    queryKey: ["app-lead", leadId],
    queryFn: async () => {
      const res = await appFetch(`/api/app/leads/${leadId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: leadId !== null,
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await appFetch(`/api/app/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-lead", leadId] });
      onChanged();
    },
    onError: (err: Error) => toast.error("Couldn't save", { description: err.message }),
  });

  const callNow = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/leads/${leadId}/call-now`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "Failed to place the call" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to place the call");
      return data;
    },
    onSuccess: () => toast.success("Placing the call now"),
    onError: (err: Error) => toast.error("Couldn't place the call", { description: err.message }),
  });

  const syncCrm = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/leads/${leadId}/sync-crm`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "Failed to sync to CRM" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to sync to CRM");
      return data as { crm?: string; message?: string };
    },
    onSuccess: (data) => toast.success(data.message || `Synced to ${data.crm ?? "CRM"}`),
    onError: (err: Error) => toast.error("Couldn't sync to CRM", { description: err.message }),
  });

  const lead = detail.data?.lead;
  const calls = detail.data?.calls ?? [];

  return (
    <Sheet open={leadId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{lead?.name || "Lead"}</SheetTitle>
          <SheetDescription className="font-mono">{lead?.phone}</SheetDescription>
        </SheetHeader>

        {detail.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        )}

        {lead && (
          <div className="space-y-6 px-4 pb-8">
            <div className="flex items-center gap-2">
              <Button size="sm" className="gap-1.5" disabled={callNow.isPending} onClick={() => callNow.mutate()}>
                {callNow.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Phone className="size-3.5" aria-hidden />}
                Call now
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={syncCrm.isPending} onClick={() => syncCrm.mutate()}>
                {syncCrm.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Share2 className="size-3.5" aria-hidden />}
                Sync to CRM
              </Button>
              <Badge variant="outline">{SOURCE_LABEL[lead.source]}</Badge>
            </div>

            {/* Pipeline + advisor */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Pipeline stage</Label>
                <Select value={lead.status} onValueChange={(v) => patch.mutate({ status: v })}>
                  <SelectTrigger size="sm" className="capitalize"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Assigned advisor</Label>
                <Select
                  value={lead.assignedAdvisorId ? String(lead.assignedAdvisorId) : UNASSIGNED}
                  onValueChange={(v) => patch.mutate({ assignedAdvisorId: v === UNASSIGNED ? null : Number(v) })}
                >
                  <SelectTrigger size="sm"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {advisors.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {advisors.length === 0 && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                No licensed advisors yet — add them in Settings to assign leads for handoff.
              </p>
            )}

            {/* Captured fields */}
            <LeadFieldsEditor key={lead.id} lead={lead} fields={fields} onSave={(f, name) => patch.mutate({ fields: f, name })} saving={patch.isPending} />

            {/* Call history */}
            <div className="space-y-2">
              <Label className="text-xs">Call history</Label>
              {calls.length === 0 ? (
                <p className="text-xs text-muted-foreground">No calls linked to this lead yet.</p>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {calls.map((call) => (
                    <div key={call.id} className="px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium capitalize">{call.direction} · {call.status}</span>
                        <span className="text-muted-foreground">{formatWhen(call.startedAt)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-muted-foreground">
                        {call.disposition && <Badge variant="outline" className="text-[10px]">{call.disposition}</Badge>}
                        {call.intent && <Badge variant="outline" className="text-[10px]">{call.intent}</Badge>}
                        {call.sentiment && <Badge variant="outline" className="text-[10px]">{call.sentiment}</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              First seen {formatWhen(lead.firstSeenAt)} · Last activity {formatWhen(lead.lastActivityAt)}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function LeadFieldsEditor({
  lead,
  fields,
  onSave,
  saving,
}: {
  lead: LeadRow;
  fields: FieldDef[];
  onSave: (fields: Record<string, string>, name: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(lead.fields ?? {});
  const [nameDraft, setNameDraft] = useState(lead.name ?? "");

  // Reset local draft whenever we open a different lead.
  const dirty = useMemo(() => {
    const fieldsDirty = fields.some((f) => (draft[f.key] ?? "") !== (lead.fields?.[f.key] ?? ""));
    return fieldsDirty || nameDraft !== (lead.name ?? "");
  }, [draft, nameDraft, fields, lead]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Details</Label>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => onSave({ ...draft }, nameDraft.trim())}
          className="h-7 gap-1.5 text-xs"
        >
          {saving && <Loader2 className="size-3 animate-spin" aria-hidden />}
          Save
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="h-9" />
      </div>

      {fields.map((f) => (
        <FieldInput
          key={f.key}
          def={f}
          value={draft[f.key] ?? ""}
          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
        />
      ))}
    </div>
  );
}

function FieldInput({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{def.label}</Label>
      {def.type === "enum" && def.options ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger size="sm"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : def.type === "boolean" ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger size="sm"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      ) : def.key === "lead_notes" ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} />
      ) : (
        <Input
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9"
        />
      )}
    </div>
  );
}

function AddLeadDialog({
  open,
  onOpenChange,
  fields,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fields: FieldDef[];
  onCreated: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim() || undefined, fields: values }),
      });
      const data = await res.json().catch(() => ({ error: "Failed to add lead" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to add lead");
      return data;
    },
    onSuccess: (data: { created: boolean; rejectedRegulated?: string[] }) => {
      toast.success(data.created ? "Lead added" : "Merged into an existing lead with that number");
      if (data.rejectedRegulated?.length) {
        toast.warning("Some fields were dropped as regulated", { description: data.rejectedRegulated.join(", ") });
      }
      setPhone("");
      setName("");
      setValues({});
      onOpenChange(false);
      onCreated();
    },
    onError: (err: Error) => toast.error("Couldn't add lead", { description: err.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a lead</DialogTitle>
          <DialogDescription>
            Deduped by phone — adding a number that already exists merges into that lead. Regulated fields are never stored.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Phone (E.164)<span className="text-destructive"> *</span></Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" className="h-9 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
          </div>
          {fields
            .filter((f) => f.key !== "full_name")
            .map((f) => (
              <FieldInput key={f.key} def={f} value={values[f.key] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
            ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!phone.trim() || create.isPending} onClick={() => create.mutate()} className="gap-1.5">
            {create.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Add lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_TYPES: FieldDef["type"][] = ["text", "number", "enum", "boolean", "date"];

// Per-org intake-schema editor (Phase 2). Edits the field definitions the whole
// leads layer reads — Leads columns, add/edit forms, ingest, export, hosted
// form. Regulated fields are rejected server-side and surfaced back as a
// warning; an empty list resets to the vertical default.
function SchemaEditorDialog({
  open,
  onOpenChange,
  fields,
  isCustom,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fields: FieldDef[];
  isCustom: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FieldDef[]>(fields);

  // Re-seed the draft each time the dialog opens so it reflects the latest
  // saved schema (and any server-side normalization from the last save).
  const [seededFor, setSeededFor] = useState(false);
  if (open && !seededFor) {
    setDraft(fields);
    setSeededFor(true);
  }
  if (!open && seededFor) setSeededFor(false);

  const save = useMutation({
    mutationFn: async (payload: FieldDef[]) => {
      const res = await appFetch("/api/app/leads/intake-schema", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: payload }),
      });
      const data = await res.json().catch(() => ({ error: "Failed to save" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      return data as { fields: FieldDef[]; rejectedRegulated: string[]; reset: boolean };
    },
    onSuccess: (data) => {
      if (data.reset) toast.success("Reset to the default fields");
      else toast.success("Field configuration saved");
      if (data.rejectedRegulated?.length) {
        toast.warning("Some fields were rejected as regulated", { description: data.rejectedRegulated.join(", ") });
      }
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error("Couldn't save fields", { description: err.message }),
  });

  const reset = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/leads/intake-schema", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to reset");
    },
    onSuccess: () => {
      toast.success("Reset to the default fields");
      onSaved();
      onOpenChange(false);
    },
    onError: () => toast.error("Couldn't reset fields"),
  });

  function updateField(i: number, patch: Partial<FieldDef>) {
    setDraft((d) => d.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeField(i: number) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  }
  function addField() {
    setDraft((d) => [...d, { key: "", label: "", type: "text" }]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure lead fields</DialogTitle>
          <DialogDescription>
            These fields become the columns on this page, the questions on your add/edit forms, and what your agents and
            hosted form capture. Regulated identifiers (SSN, PAN, Aadhaar, bank, full DOB, health) can't be added — they're
            rejected on save. {isCustom ? "You're using a custom set." : "You're using the default set for your vertical."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {draft.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              No fields — saving an empty list resets to your vertical's default.
            </p>
          )}
          {draft.map((f, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Label</Label>
                    <Input
                      value={f.label}
                      onChange={(e) => updateField(i, { label: e.target.value })}
                      placeholder="e.g. Policy interest"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Type</Label>
                    <Select value={f.type} onValueChange={(v) => updateField(i, { type: v as FieldDef["type"] })}>
                      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="mt-5 size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeField(i)}
                  aria-label="Remove field"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              {f.type === "enum" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs text-muted-foreground">Options (comma-separated)</Label>
                  <Input
                    value={(f.options ?? []).join(", ")}
                    onChange={(e) =>
                      updateField(i, {
                        options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean),
                      })
                    }
                    placeholder="e.g. Auto, Home, Life"
                    className="h-9"
                  />
                </div>
              )}
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={!!f.required}
                  onChange={(e) => updateField(i, { required: e.target.checked })}
                  className="size-3.5"
                />
                Required
              </label>
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={addField}>
            <Plus className="size-3.5" aria-hidden />
            Add field
          </Button>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={!isCustom || reset.isPending}
            onClick={() => reset.mutate()}
          >
            {reset.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate(draft)} className="gap-1.5">
              {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Save fields
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
