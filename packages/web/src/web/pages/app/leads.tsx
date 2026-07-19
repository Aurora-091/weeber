import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Loader as Loader2, Search, Download, Plus, ShieldAlert, UserRound } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
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
  capturedState: Record<string, string> | null;
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

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function UserLeadsPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [openLeadId, setOpenLeadId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const leads = useQuery<{ leads: LeadRow[] }>({
    queryKey: ["app-leads", query.trim()],
    queryFn: async () => {
      const res = await appFetch(`/api/app/leads${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: 20000,
  });

  const schema = useQuery<{ fields: FieldDef[] }>({
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
      {leads.isError && <EmptyState title="Couldn't load leads" description="Something went wrong reaching the server — try refreshing." />}
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
    </div>
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
