import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader as Loader2, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// Public, embeddable intake form (Phase 3, native leads layer §10). A thin
// client of the ingest core: reads the org's field schema by its public form
// token (the org UUID in the URL) and submits a lead to /api/public/leads/:orgId/form.
// No auth, no app shell — anyone with the link can submit.

type FieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "enum" | "boolean" | "date";
  required?: boolean;
  options?: string[];
  piiClass?: string;
};

type FormSchema = { orgName: string | null; fields: FieldDef[] };

function FormField({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {def.label}
        {def.required && <span className="text-destructive"> *</span>}
      </Label>
      {def.type === "enum" && def.options?.length ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : def.type === "boolean" ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      ) : def.key === "lead_notes" ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <Input
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function HostedFormPage() {
  const params = useParams();
  const orgId = params.orgId ?? "";

  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  // Honeypot — a real user never sees or fills this. Bots do, and the server
  // silently drops those submissions.
  const [website, setWebsite] = useState("");
  const [done, setDone] = useState(false);

  const schema = useQuery<FormSchema>({
    queryKey: ["hosted-form-schema", orgId],
    queryFn: async () => {
      const res = await apiFetch(`/api/public/leads/${orgId}/form`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: !!orgId,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/public/leads/${orgId}/form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim() || undefined, fields: values, _website: website }),
      });
      const data = await res.json().catch(() => ({ error: "Submission failed" }));
      if (!res.ok) throw new Error(data.error ?? "Submission failed");
      return data;
    },
    onSuccess: () => setDone(true),
  });

  const fields = schema.data?.fields ?? [];
  const canSubmit = phone.trim().length > 0 && fields.filter((f) => f.required).every((f) => (values[f.key] ?? "").trim());

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-sm sm:p-8">
        {schema.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        )}

        {schema.isError && (
          <div className="py-8 text-center">
            <h1 className="text-lg font-semibold">Form not found</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This intake form link is invalid or has been removed. Check with whoever shared it with you.
            </p>
          </div>
        )}

        {schema.data && done && (
          <div className="py-8 text-center">
            <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden />
            <h1 className="mt-3 text-lg font-semibold">Thanks — we've got your details</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {schema.data.orgName ? `${schema.data.orgName} will` : "The team will"} be in touch shortly.
            </p>
          </div>
        )}

        {schema.data && !done && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-semibold">
                {schema.data.orgName ? `Contact ${schema.data.orgName}` : "Get in touch"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Fill this in and we'll reach out. Fields marked * are required.
              </p>
            </div>

            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit && !submit.isPending) submit.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label className="text-sm">Phone<span className="text-destructive"> *</span></Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+15551234567"
                  className="font-mono"
                  inputMode="tel"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              {fields
                .filter((f) => f.key !== "full_name")
                .map((f) => (
                  <FormField
                    key={f.key}
                    def={f}
                    value={values[f.key] ?? ""}
                    onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                  />
                ))}

              {/* Honeypot — visually hidden, off-screen, not tab-reachable. */}
              <div aria-hidden className="absolute left-[-9999px] top-[-9999px] h-0 w-0 overflow-hidden">
                <label>
                  Website
                  <input
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                  />
                </label>
              </div>

              {submit.isError && (
                <p className="text-sm text-destructive">
                  {(submit.error as Error)?.message ?? "Something went wrong — please try again."}
                </p>
              )}

              <Button type="submit" className="w-full gap-1.5" disabled={!canSubmit || submit.isPending}>
                {submit.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Submit
              </Button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">Powered by Weeber</p>
      </div>
    </div>
  );
}
