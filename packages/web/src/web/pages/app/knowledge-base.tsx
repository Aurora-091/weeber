import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FileText, Link as LinkIcon, File, Trash2, Loader as Loader2, RefreshCw, CircleAlert as AlertCircle } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";

type KnowledgeDocument = {
  id: number;
  title: string;
  sourceType: "text" | "url" | "pdf";
  sourceUrl: string | null;
  status: "processing" | "ready" | "failed";
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
};

const SOURCE_TABS = [
  { key: "text", label: "Paste text", icon: FileText },
  { key: "url", label: "From a URL", icon: LinkIcon },
  { key: "pdf", label: "Upload a PDF", icon: File },
] as const;

function StatusBadge({ status, errorMessage }: { status: KnowledgeDocument["status"]; errorMessage: string | null }) {
  if (status === "ready") {
    return <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">Ready</span>;
  }
  if (status === "failed") {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive" title={errorMessage ?? undefined}>
        Failed
      </span>
    );
  }
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Processing…</span>;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function UserKnowledgeBasePage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<(typeof SOURCE_TABS)[number]["key"]>("text");
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  const documents = useQuery({
    queryKey: ["app-knowledge-base"],
    queryFn: async () => {
      const res = await appFetch("/api/app/knowledge-base");
      if (!res.ok) throw new Error(`knowledge-base failed (${res.status})`);
      return (await res.json()) as { documents: KnowledgeDocument[] };
    },
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      return docs.some((d) => d.status === "processing") ? 3000 : false;
    },
  });

  const rows = documents.data?.documents ?? [];

  function resetForm() {
    setTitle("");
    setRawText("");
    setSourceUrl("");
    setPdfFile(null);
  }

  const upload = useMutation({
    mutationFn: async () => {
      let body: Record<string, unknown> = { title, sourceType: activeTab };
      if (activeTab === "text") body.rawText = rawText;
      if (activeTab === "url") body.sourceUrl = sourceUrl;
      if (activeTab === "pdf") {
        if (!pdfFile) throw new Error("Choose a PDF file first");
        body.pdfBase64 = await fileToBase64(pdfFile);
      }
      const res = await appFetch("/api/app/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      return data;
    },
    onSuccess: () => {
      toast.success("Added to knowledge base — processing now.");
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["app-knowledge-base"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      const res = await appFetch(`/api/app/knowledge-base/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Delete failed" }));
        throw new Error(data.error ?? "Delete failed");
      }
    },
    onSuccess: () => {
      toast.success("Removed");
      queryClient.invalidateQueries({ queryKey: ["app-knowledge-base"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const canSubmit =
    title.trim().length > 0 &&
    ((activeTab === "text" && rawText.trim().length > 0) ||
      (activeTab === "url" && sourceUrl.trim().length > 0) ||
      (activeTab === "pdf" && pdfFile !== null));

  return (
    <div className="page-enter">
      <PageHeader
        title="Knowledge Base"
        description="Give your agents facts to answer from — paste FAQ text, link a page, or upload a PDF. Agents search this live during a call instead of guessing."
      />

      <div className="card-weeber p-6 mb-6">
        <div className="mb-4 flex gap-1 rounded-lg bg-muted/60 p-1 w-fit">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === tab.key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <tab.icon className="size-3.5" aria-hidden />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="space-y-3 max-w-xl">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Shipping & returns FAQ" />
          </div>

          {activeTab === "text" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Text</Label>
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={6}
                placeholder="Paste your FAQ, policy text, or any facts your agent should know…"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}

          {activeTab === "url" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">URL</Label>
              <Input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://yourstore.com/faq"
              />
            </div>
          )}

          {activeTab === "pdf" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">PDF file</Label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium"
              />
              <p className="text-xs text-muted-foreground">Text-layer PDFs only — a scanned/image-only PDF won't extract any text.</p>
            </div>
          )}

          <Button size="sm" disabled={!canSubmit || upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {upload.isPending ? "Adding…" : "Add to knowledge base"}
          </Button>
        </div>
      </div>

      {documents.isLoading && <SkeletonCards count={2} lines={2} />}
      {documents.isError && (
        <EmptyState
          title="Couldn't load your knowledge base"
          description="Something went wrong reaching the server. Check your connection and try again."
          icon={AlertCircle}
          action={
            <Button size="sm" variant="outline" onClick={() => documents.refetch()}>
              <RefreshCw className="size-3.5" aria-hidden />
              Retry
            </Button>
          }
        />
      )}

      {!documents.isLoading && !documents.isError && rows.length === 0 && (
        <EmptyState
          icon={BookOpen}
          title="No documents yet"
          description="Add your first FAQ, policy page, or PDF above — your agents will start answering from it right away."
        />
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border content-fade-in">
          {rows.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{doc.title}</span>
                  <StatusBadge status={doc.status} errorMessage={doc.errorMessage} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {doc.sourceType === "pdf" ? "PDF" : doc.sourceType === "url" ? doc.sourceUrl : "Pasted text"}
                  {doc.status === "ready" && ` · ${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"}`}
                  {doc.status === "failed" && doc.errorMessage ? ` · ${doc.errorMessage}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove.mutate(doc.id)}
                disabled={remove.isPending}
                className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                aria-label={`Remove ${doc.title}`}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
