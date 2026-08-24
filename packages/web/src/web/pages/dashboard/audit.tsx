import { useState } from "react";
import { ShieldCheck, Download, Search } from "lucide-react";
import { adminHeaders } from "../../lib/admin-key";
import { apiFetch } from "../../lib/api";
import { Button } from "../../components/ui/button";

/**
 * Per-number compliance audit lookup — the more common real request
 * ("show me everything about how this number was contacted") vs. a single
 * call's audit (available from the call detail page). Direct answer to
 * real user feedback that producing this on demand is what actually kills
 * the TCPA/DNC compliance fear — see @weeber/compliance's audit-trail.ts and
 * DECISIONS.md/ROADMAP.md for the full reasoning.
 */
export function AuditPage() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    if (!phoneNumber) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/voice/callers/${encodeURIComponent(phoneNumber)}/audit?format=text`, {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setPreview(await res.text());
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!preview) return;
    const blob = new Blob([preview], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vent-audit-${phoneNumber.replace(/[^0-9+]/g, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="size-5 text-success" />
          Compliance audit
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Look up every call involving a number — consent/disclosure status, disposition, Do-Not-Call
          status, and the full transcript for each call, assembled into one exportable record. Built from
          data already collected, no reconstruction needed if you ever get asked to prove compliance.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
        className="flex flex-col sm:flex-row gap-2 mb-6"
      >
        <input
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="+15551234567"
          aria-label="Phone number"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring/40"
        />
        <Button
          type="submit"
          disabled={!phoneNumber || loading}
        >
          <Search className="size-4 mr-1.5" />
          {loading ? "Looking up…" : "Look up"}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive mb-4">{error}</p>}

      {preview && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground">Preview</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={download}
            >
              <Download className="size-4 mr-1.5" />
              Download .txt
            </Button>
          </div>
          <pre className="rounded-lg border border-border bg-muted/40 p-4 text-xs font-mono whitespace-pre-wrap max-h-[60vh] overflow-y-auto">
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}
