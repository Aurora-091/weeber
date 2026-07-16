import type { DncStorageAdapter } from "./storage";

/**
 * Compliance audit trail — the direct answer to a piece of real user
 * feedback (see OpenVent's DECISIONS.md / ROADMAP.md, feedback round 3): the
 * thing that actually kills the TCPA/DNC compliance fear isn't another
 * warning banner, it's being able to produce, on demand, exactly who was
 * called, when, under what consent basis, what disposition, and what the
 * agent said. OpenVent already collects all of this (calls, transcripts,
 * disposition, DNC status) — this module is the missing step that packages
 * it into a single exportable, audit-ready record instead of leaving an
 * operator to reconstruct it by hand from multiple tables under pressure
 * (e.g. during an actual regulatory inquiry).
 *
 * Framework-agnostic like the rest of this package — bring your own call-log
 * storage via CallAuditStorageAdapter (see storage.ts's CallLogStorageAdapter
 * for the sibling pattern this follows) and this module does the assembly
 * and formatting, not the persistence.
 */

export type CallAuditRecord = {
  callId: string;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  disposition: string | null;
  /**
   * Whether the recording/AI disclosure line (see consent.ts) was actually
   * present in the call's transcript — not just whether it was configured
   * on. Configuration says what *should* have happened; this says what
   * *did* happen, which is the actual audit-relevant question. A call
   * where disclosure was enabled but, say, the agent's opening turn was
   * empty/failed, should show up as unconfirmed, not silently assumed fine.
   */
  disclosureConfirmed: boolean;
  /**
   * The exact disclosure wording this specific call was configured to speak,
   * as captured at call start (calls.disclosure_text). Null for pre-migration
   * calls or calls placed with disclosure disabled — in which case the
   * confirmation check falls back to the app-level default wording passed to
   * buildCallAuditRecord. Surfacing it makes the audit self-contained: a
   * reviewer sees what should have been said AND whether it was.
   */
  disclosureText: string | null;
  /** Which disclosure variant was used ("en"/"hi"/"hinglish"/"custom"), for grouping/verifying an audit by language. Null for pre-migration calls. */
  disclosureVersion: string | null;
  /** Full turn-by-turn transcript, oldest first — the actual record of what was said. */
  transcript: { role: "caller" | "agent"; text: string; at: Date }[];
  /** Whether this number was ever added to the Do-Not-Call list, and when/why, if so — checked at export time, not at call time (a number can be DNC'd after a call happened). */
  dncStatus: { isListed: boolean; reason?: string; addedAt?: Date };
};

/**
 * Minimal surface this module needs from your call-log storage to assemble
 * an audit record — implement against your own database (see the OpenVent
 * reference app's Drizzle adapter for a production example, or
 * adapters/memory.ts for tests).
 */
export type CallAuditStorageAdapter = {
  /** A single call's core metadata, or null if the call id doesn't exist. */
  getCall(callId: string): Promise<{
    callId: string;
    direction: "inbound" | "outbound";
    fromNumber: string;
    toNumber: string;
    startedAt: Date;
    endedAt: Date | null;
    status: string;
    disposition: string | null;
    /** Per-call disclosure wording captured at call start, if your storage persists it (calls.disclosure_text). Optional for backward compatibility. */
    disclosureText?: string | null;
    /** Per-call disclosure variant tag ("en"/"hi"/"hinglish"/"custom"), if persisted. Optional for backward compatibility. */
    disclosureVersion?: string | null;
  } | null>;
  /** Full transcript for a call, oldest turn first. */
  getTranscript(callId: string): Promise<{ role: "caller" | "agent"; text: string; at: Date }[]>;
  /** Every call involving this phone number (as caller or callee), most useful for a per-number audit request. */
  findCallsByPhoneNumber(phoneNumber: string): Promise<{ callId: string }[]>;
};

/**
 * Best-effort check for whether the disclosure line was actually spoken —
 * looks for the configured disclosure text (or a reasonable default
 * fragment of it) in the agent's first transcript turn. This is
 * deliberately conservative (a substring match, not fuzzy matching) so a
 * false "confirmed" is unlikely; a false "not confirmed" just means the
 * operator should double-check that specific call, which is the safe
 * failure direction for an audit tool.
 */
function wasDisclosureSpoken(
  transcript: { role: "caller" | "agent"; text: string }[],
  disclosureText: string,
): boolean {
  const firstAgentTurn = transcript.find((t) => t.role === "agent");
  if (!firstAgentTurn) return false;
  // Compare a meaningful fragment, not the whole sentence verbatim — TTS/LLM
  // phrasing can vary slightly turn to turn even with the same instruction.
  const fragment = disclosureText.slice(0, 30).toLowerCase();
  return firstAgentTurn.text.toLowerCase().includes(fragment);
}

/**
 * Assembles a single call's full audit record — the core building block.
 * `fallbackDisclosureText` is used only when a call has no per-call disclosure
 * persisted (pre-migration rows): pass whatever your app configures as the
 * default (see consent.ts's getDisclosureLine()). When the call row DOES carry
 * its own `disclosureText`, that per-call wording is used for the "was it
 * spoken" check instead — so a Hindi call is verified against the Hindi line,
 * not the English default.
 */
export async function buildCallAuditRecord(
  callId: string,
  storage: CallAuditStorageAdapter,
  dncAdapter: DncStorageAdapter,
  fallbackDisclosureText: string,
): Promise<CallAuditRecord | null> {
  const call = await storage.getCall(callId);
  if (!call) return null;

  const transcript = await storage.getTranscript(callId);
  // Prefer the wording THIS call was actually configured to speak; only fall
  // back to the app default for calls that predate per-call persistence.
  const disclosureText = call.disclosureText ?? null;
  const disclosureVersion = call.disclosureVersion ?? null;
  const disclosureConfirmed = wasDisclosureSpoken(transcript, disclosureText ?? fallbackDisclosureText);

  const isListed = await dncAdapter.isListed(call.toNumber);
  let dncStatus: CallAuditRecord["dncStatus"] = { isListed };
  if (isListed) {
    const entries = await dncAdapter.list();
    const entry = entries.find((e) => e.phoneNumber === call.toNumber);
    if (entry) dncStatus = { isListed: true, reason: entry.reason, addedAt: entry.addedAt };
  }

  return { ...call, transcript, disclosureText, disclosureVersion, disclosureConfirmed, dncStatus };
}

/**
 * Assembles audit records for every call involving a phone number — the
 * more common real request ("show me everything about how this number was
 * contacted"), not just a single call id. Records are returned oldest-first
 * by call start time.
 */
export async function buildPhoneNumberAuditTrail(
  phoneNumber: string,
  storage: CallAuditStorageAdapter,
  dncAdapter: DncStorageAdapter,
  fallbackDisclosureText: string,
): Promise<CallAuditRecord[]> {
  const calls = await storage.findCallsByPhoneNumber(phoneNumber);
  const records = await Promise.all(
    calls.map((c) => buildCallAuditRecord(c.callId, storage, dncAdapter, fallbackDisclosureText)),
  );
  return records
    .filter((r): r is CallAuditRecord => r !== null)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/**
 * Renders one or more audit records as plain-text, human-readable output —
 * the format you'd actually hand to a lawyer or compliance officer on
 * request, not a raw JSON dump. JSON is still available by serializing
 * CallAuditRecord[] directly if a machine-readable format is what's needed
 * instead (e.g. for a compliance tooling integration).
 */
export function renderAuditTrailText(records: CallAuditRecord[]): string {
  if (records.length === 0) return "No calls found for this query.";

  const sections = records.map((r, i) => {
    const lines = [
      `Call ${i + 1} of ${records.length} — ${r.callId}`,
      `  Direction: ${r.direction}`,
      `  From: ${r.fromNumber}  To: ${r.toNumber}`,
      `  Started: ${r.startedAt.toISOString()}`,
      `  Ended: ${r.endedAt ? r.endedAt.toISOString() : "(call still in progress or ended abnormally)"}`,
      `  Status: ${r.status}`,
      `  Disposition: ${r.disposition ?? "(none recorded)"}`,
      `  Recording/AI disclosure spoken: ${r.disclosureConfirmed ? "yes" : "NOT CONFIRMED"}${
        r.disclosureVersion ? ` (variant: ${r.disclosureVersion})` : ""
      }`,
      `  Disclosure wording configured: ${r.disclosureText ?? "(not recorded for this call)"}`,
      `  Do-Not-Call status: ${
        r.dncStatus.isListed
          ? `ON THE LIST${r.dncStatus.reason ? ` (${r.dncStatus.reason})` : ""}${
              r.dncStatus.addedAt ? `, added ${r.dncStatus.addedAt.toISOString()}` : ""
            }`
          : "not listed"
      }`,
      `  Transcript:`,
      ...r.transcript.map((t) => `    [${t.at.toISOString()}] ${t.role}: ${t.text}`),
    ];
    return lines.join("\n");
  });

  return sections.join("\n\n---\n\n");
}
