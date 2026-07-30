import type { ConsentPurpose, ConsentRecord, ConsentStorageAdapter, DncStorageAdapter } from "./storage";

/**
 * Compliance audit trail — the direct answer to a piece of real user
 * feedback (see OpenVent's DECISIONS.md / ROADMAP.md, feedback round 3): the
 * thing that actually kills the TCPA/DNC compliance fear isn't another
 * warning banner, it's being able to produce, on demand, exactly who was
 * called, when, under what consent basis, what disposition, and what the
 * agent said. OpenVent already collects all of this (calls, transcripts,
 * disposition, DNC status, and — since ADR-062 — the consent ledger,
 * disclosure-fired timestamp, and per-call opt-out events) — this module is
 * the missing step that packages it into a single exportable, audit-ready
 * record instead of leaving an operator to reconstruct it by hand from
 * multiple tables under pressure (e.g. during an actual regulatory inquiry).
 *
 * ADR-062 (2026-07-30) reframed the export from a metadata dump into the
 * single legal question an inquiry actually asks: *who was called, when,
 * under what consent, what was disclosed, did they opt out, and what was
 * said.* Everything read here comes from canonical state (the calls,
 * consent-ledger, do-not-call, and opt-out tables), not re-derived from the
 * transcript — the transcript is evidence of what was said, not the source
 * of truth for whether consent existed. The one exception is the disclosure
 * substring check (`disclosureConfirmed`), kept only as a fallback
 * confirmation that the configured line actually made it into the audio.
 *
 * Framework-agnostic like the rest of this package — bring your own call-log
 * storage via CallAuditStorageAdapter (see storage.ts's CallLogStorageAdapter
 * for the sibling pattern this follows) and this module does the assembly
 * and formatting, not the persistence.
 */

/**
 * Consent tier, in the vocabulary an auditor actually uses:
 * - PEC  = "prior express consent" — oral consent is sufficient
 *          (informational/service calls: clinic reminders, Shopify order
 *          status, transactional confirmations).
 * - PEWC = "prior express *written* consent" — a signed/recorded written
 *          agreement is required (marketing/promotional calls, and anything
 *          feeding an underwriting/eligibility decision). This is the higher
 *          bar; a service/transactional grant never satisfies it.
 * See tierForPurpose below for the purpose→tier mapping.
 */
export type ConsentTier = "PEC" | "PEWC";

/**
 * One line of the "under what consent" answer — the standing consent record
 * for a single purpose, already resolved to plain-language pieces the
 * renderer (or a dashboard) can show without re-deriving legal meaning.
 */
export type ConsentBasisEntry = {
  purpose: ConsentPurpose;
  tier: ConsentTier;
  grantedAt: Date;
  /** Which consent-notice wording they agreed to (audit needs *what* was agreed, not just that something was). */
  version: string;
  channel: ConsentRecord["channel"];
  /** Free-text on how it was captured, e.g. "checkout consent checkbox". */
  source: string;
  /** Whether this consent is currently standing: granted, not withdrawn, not expired. */
  active: boolean;
  withdrawnAt: Date | null;
};

/**
 * One per-call opt-out event — the "did they opt out" answer, captured at the
 * moment the caller asked to stop (e.g. the agent recorded a
 * cancellation/opt-out intent), independent of the current DNC-list state
 * (`dncStatus`), which is a point-in-time lookup at export time. A number can
 * opt out on this call and be scrubbed later, or opt out and never make it
 * onto the list — both are audit-relevant and this captures the call-time fact.
 */
export type CallOptOutEvent = {
  firedAt: Date;
  /** The phrase/tool signal that triggered the opt-out, if captured — null when only the fact was recorded. */
  triggerPhrase: string | null;
  /** When this opt-out was propagated to the Do-Not-Call list, if it was — null means not (yet) scrubbed. */
  dncPropagatedAt: Date | null;
};

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
   * The "under what consent" answer, read from the consent ledger (canonical
   * state), not the transcript. One entry per purpose with a standing record
   * for this number under this org. Empty when no consent adapter was wired
   * in, or when the number has no consent records at all — an empty array is
   * itself audit-relevant (it means the call rested on no recorded consent).
   */
  consentBasis: ConsentBasisEntry[];
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
   * When the disclosure/opening turn actually fired on this call, read from
   * canonical state (calls.disclosureFiredAt), not inferred from transcript
   * timestamps. Null when the disclosure never fired, or the call predates
   * this column — either way, "no recorded fire time" rather than a guess.
   */
  disclosureFiredAt: Date | null;
  /** Per-call opt-out events (the "did they opt out" answer), oldest first. Empty when none. */
  optOutEvents: CallOptOutEvent[];
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
    /** Owning org — needed to scope the consent lookup (same number can belong to multiple orgs). Optional for back-compat with adapters that predate ADR-062. */
    orgId?: string | null;
    /** When the disclosure/opening turn fired (ADR-062). Optional for back-compat. */
    disclosureFiredAt?: Date | null;
  } | null>;
  /** Full transcript for a call, oldest turn first. */
  getTranscript(callId: string): Promise<{ role: "caller" | "agent"; text: string; at: Date }[]>;
  /** Every call involving this phone number (as caller or callee), most useful for a per-number audit request. */
  findCallsByPhoneNumber(phoneNumber: string): Promise<{ callId: string }[]>;
  /**
   * Per-call opt-out events (ADR-062). Optional so adapters that predate this
   * feature still satisfy the interface — when absent, records simply carry
   * an empty `optOutEvents` array (safe: "none recorded", not "definitely none").
   */
  getOptOutEvents?(callId: string): Promise<CallOptOutEvent[]>;
};

/**
 * A per-org consent adapter factory (see the OpenVent app's
 * createConsentAdapterForOrg). The audit module resolves consent per call
 * from the call's own orgId, because the same phone number can be a customer
 * of more than one org and consent granted to one org must never appear as
 * the basis for another org's call. Optional throughout — omit it and records
 * carry an empty `consentBasis` (the pre-ADR-062 behavior).
 */
export type ConsentAdapterFactory = (orgId: string) => ConsentStorageAdapter;

/**
 * Purpose → consent-tier mapping. Marketing (promotional outreach: cart
 * recovery, upsell) and underwriting (anything that could feed an
 * eligibility decision) require prior express *written* consent (PEWC).
 * Service, transactional, and feedback calls are informational/expected and
 * satisfied by oral prior express consent (PEC). This is deliberately
 * conservative on the two that carry real regulatory teeth; everything else
 * is the lower bar.
 */
export function tierForPurpose(purpose: ConsentPurpose): ConsentTier {
  return purpose === "marketing" || purpose === "underwriting" ? "PEWC" : "PEC";
}

/**
 * Collapses a full consent ledger (many rows per principal — one per purpose,
 * plus a new row each re-grant) into the *standing* consent per purpose: the
 * most recent record for each purpose, resolved to active/withdrawn/expired.
 * This is what an auditor wants to see ("what consent authorized this call"),
 * not the entire grant/withdraw history, which is available from the ledger
 * directly if needed.
 */
function summarizeConsent(records: ConsentRecord[], now: Date): ConsentBasisEntry[] {
  const latestByPurpose = new Map<ConsentPurpose, ConsentRecord>();
  for (const r of records) {
    const existing = latestByPurpose.get(r.purpose);
    if (!existing || r.grantedAt.getTime() > existing.grantedAt.getTime()) {
      latestByPurpose.set(r.purpose, r);
    }
  }
  return [...latestByPurpose.values()]
    .sort((a, b) => a.purpose.localeCompare(b.purpose))
    .map((r) => {
      const expired = Boolean(r.expiresAt && r.expiresAt.getTime() <= now.getTime());
      return {
        purpose: r.purpose,
        tier: tierForPurpose(r.purpose),
        grantedAt: r.grantedAt,
        version: r.version,
        channel: r.channel,
        source: r.source,
        active: r.granted && !r.withdrawnAt && !expired,
        withdrawnAt: r.withdrawnAt ?? null,
      };
    });
}

/**
 * Best-effort check for whether the disclosure line was actually spoken —
 * looks for the configured disclosure text (or a reasonable default
 * fragment of it) in the agent's first transcript turn. This is
 * deliberately conservative (a substring match, not fuzzy matching) so a
 * false "confirmed" is unlikely; a false "not confirmed" just means the
 * operator should double-check that specific call, which is the safe
 * failure direction for an audit tool. Post-ADR-062 this is a *fallback*
 * confirmation of content — the authoritative "did disclosure fire" signal
 * is `disclosureFiredAt` from canonical state.
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
  if (!fragment) return false;
  return firstAgentTurn.text.toLowerCase().includes(fragment);
}

/**
 * Assembles a single call's full audit record — the core building block.
 * `disclosureText` should be whatever your app actually configured (see
 * consent.ts's getDisclosureLine()) so the fallback content check reflects
 * your real wording, not a hardcoded guess. `consentFactory`, when provided,
 * is used to read the consent ledger scoped to this call's own org.
 */
export async function buildCallAuditRecord(
  callId: string,
  storage: CallAuditStorageAdapter,
  dncAdapter: DncStorageAdapter,
  disclosureText: string,
  consentFactory?: ConsentAdapterFactory,
): Promise<CallAuditRecord | null> {
  const call = await storage.getCall(callId);
  if (!call) return null;

  const now = new Date();
  const transcript = await storage.getTranscript(callId);
  const disclosureConfirmed = wasDisclosureSpoken(transcript, disclosureText);

  // "Under what consent" — read from the ledger (canonical state), scoped to
  // this call's own org. Skipped entirely when no factory is wired or the
  // call has no org (self-hosted/no-tenant), leaving consentBasis empty.
  let consentBasis: ConsentBasisEntry[] = [];
  if (consentFactory && call.orgId) {
    const consentRecords = await consentFactory(call.orgId).listForPrincipal(call.toNumber);
    consentBasis = summarizeConsent(consentRecords, now);
  }

  // "Did they opt out" — per-call events, distinct from the current DNC-list
  // state below.
  const optOutEvents = storage.getOptOutEvents ? await storage.getOptOutEvents(callId) : [];

  const isListed = await dncAdapter.isListed(call.toNumber);
  let dncStatus: CallAuditRecord["dncStatus"] = { isListed };
  if (isListed) {
    const entries = await dncAdapter.list();
    const entry = entries.find((e) => e.phoneNumber === call.toNumber);
    if (entry) dncStatus = { isListed: true, reason: entry.reason, addedAt: entry.addedAt };
  }

  return {
    callId: call.callId,
    direction: call.direction,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    status: call.status,
    disposition: call.disposition,
    consentBasis,
    disclosureConfirmed,
    disclosureFiredAt: call.disclosureFiredAt ?? null,
    optOutEvents,
    transcript,
    dncStatus,
  };
}

/**
 * Assembles audit records for every call involving a phone number — the
 * more common real request ("show me everything about how this number was
 * contacted"), not just a single call id. Records are returned oldest-first
 * by call start time. Consent is resolved per call from each call's own org
 * (see ConsentAdapterFactory) — a number contacted by two orgs shows each
 * call under only its own org's consent.
 */
export async function buildPhoneNumberAuditTrail(
  phoneNumber: string,
  storage: CallAuditStorageAdapter,
  dncAdapter: DncStorageAdapter,
  disclosureText: string,
  consentFactory?: ConsentAdapterFactory,
): Promise<CallAuditRecord[]> {
  const calls = await storage.findCallsByPhoneNumber(phoneNumber);
  const records = await Promise.all(
    calls.map((c) => buildCallAuditRecord(c.callId, storage, dncAdapter, disclosureText, consentFactory)),
  );
  return records
    .filter((r): r is CallAuditRecord => r !== null)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Plain-language date ("12 Mar 2026"), UTC-based so output is deterministic regardless of server timezone. */
function formatPlainDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const PURPOSE_LABEL: Record<ConsentPurpose, string> = {
  service: "Service",
  transactional: "Transactional",
  marketing: "Marketing",
  underwriting: "Underwriting",
  feedback: "Feedback",
};

/** One plain-language consent line, e.g. "Marketing consent (written / PEWC), granted 12 Mar 2026 — active". */
function renderConsentEntry(e: ConsentBasisEntry): string {
  const bar = e.tier === "PEWC" ? "written" : "oral";
  const status = e.active
    ? "active"
    : e.withdrawnAt
      ? `WITHDRAWN ${formatPlainDate(e.withdrawnAt)}`
      : "not active (expired or revoked)";
  return (
    `${PURPOSE_LABEL[e.purpose]} consent (${bar} / ${e.tier}), granted ${formatPlainDate(e.grantedAt)} — ${status} ` +
    `[via ${e.channel}: ${e.source}; notice ${e.version}]`
  );
}

/**
 * Renders one or more audit records as plain-text, human-readable output —
 * the format you'd actually hand to a lawyer or compliance officer on
 * request, not a raw JSON dump. Per ADR-062 each call reads as a scannable
 * consent + action timeline answering, in order: who was called, under what
 * consent, what was disclosed and when, whether they opted out, and finally
 * what was said. JSON is still available by serializing CallAuditRecord[]
 * directly if a machine-readable format is what's needed instead.
 */
export function renderAuditTrailText(records: CallAuditRecord[]): string {
  if (records.length === 0) return "No calls found for this query.";

  const sections = records.map((r, i) => {
    const consentLines =
      r.consentBasis.length > 0
        ? r.consentBasis.map((e) => `    • ${renderConsentEntry(e)}`)
        : ["    • No consent record on file for this number under this org."];

    const optOutLines =
      r.optOutEvents.length > 0
        ? r.optOutEvents.map(
            (e) =>
              `    • Caller opted out at ${e.firedAt.toISOString()}` +
              `${e.triggerPhrase ? ` ("${e.triggerPhrase}")` : ""}` +
              `${
                e.dncPropagatedAt
                  ? ` — added to Do-Not-Call at ${e.dncPropagatedAt.toISOString()}`
                  : " — not yet propagated to Do-Not-Call list"
              }`,
          )
        : ["    • No opt-out recorded on this call."];

    const lines = [
      `Call ${i + 1} of ${records.length} — ${r.callId}`,
      `  Who / when:`,
      `    Direction: ${r.direction}`,
      `    From: ${r.fromNumber}  To: ${r.toNumber}`,
      `    Started: ${r.startedAt.toISOString()}`,
      `    Ended: ${r.endedAt ? r.endedAt.toISOString() : "(call still in progress or ended abnormally)"}`,
      `    Status: ${r.status}`,
      `    Disposition: ${r.disposition ?? "(none recorded)"}`,
      `  Consent basis:`,
      ...consentLines,
      `  Disclosure (AI + recording):`,
      `    Spoken: ${r.disclosureConfirmed ? "yes" : "NOT CONFIRMED"}${
        r.disclosureFiredAt ? ` — fired ${r.disclosureFiredAt.toISOString()}` : " — no recorded fire time"
      }`,
      `  Opt-out:`,
      ...optOutLines,
      `  Do-Not-Call status (current): ${
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
