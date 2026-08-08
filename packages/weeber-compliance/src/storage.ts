/**
 * Storage adapter contract. This package has zero database dependency —
 * bring your own persistence by implementing this interface against
 * whatever you already use (Drizzle/Postgres, Mongo, a flat file, Redis,
 * an in-memory Map for tests, etc). See adapters/memory.ts for a minimal
 * reference implementation, and the Weeber app
 * (voice/compliance/adapter.ts) for a production Drizzle/Turso example.
 */

export type DoNotCallEntry = {
  phoneNumber: string;
  reason?: string;
  source: "manual" | "agent" | "national-registry";
  addedAt: Date;
};

export type CallRecord = {
  id: string;
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
};

/**
 * Minimal surface the compliance package needs from your call-log storage
 * to support GDPR retention purge and right-to-erasure. Implement only
 * these three methods against your existing calls table/collection.
 */
export type CallLogStorageAdapter = {
  /** Return calls started before `cutoff` — used by the retention purge sweep. */
  findCallsStartedBefore(cutoff: Date): Promise<CallRecord[]>;
  /** Return every call involving this phone number (as caller or callee) — used by right-to-erasure. */
  findCallsByPhoneNumber(phoneNumber: string): Promise<CallRecord[]>;
  /** Delete a call and any data associated with it (transcripts, tool calls, recordings, etc). */
  deleteCall(callId: string): Promise<void>;
};

/**
 * Minimal surface the compliance package needs to enforce and manage a
 * Do-Not-Call list. Implement against your own storage — see
 * adapters/memory.ts for the simplest possible version.
 */
export type DncStorageAdapter = {
  isListed(phoneNumber: string): Promise<boolean>;
  add(entry: DoNotCallEntry): Promise<void>;
  remove(phoneNumber: string): Promise<void>;
  list(): Promise<DoNotCallEntry[]>;
};

/**
 * Consent ledger (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #6) — replaces a single blanket "marketing consent"
 * boolean with a real, purpose-scoped, auditable record. Deliberately generic (not India-only,
 * not one-purpose-only) so it serves DPDP purpose-limitation, TCPA's "prior express consent," and
 * GDPR's consent-as-one-of-6-lawful-bases alike, without a separate ledger per jurisdiction.
 *
 * Purposes: `service` (fulfilling something the recipient already asked for — order status,
 * appointment confirmation/reminder — not a separate ask, but still recorded so its scope is
 * explicit), `transactional` (COD confirmation, payment/booking confirmation), `marketing`
 * (promotional outreach — cart recovery discount offers, upsell), `underwriting` (any call whose
 * content could inform an underwriting/eligibility decision — must NEVER be satisfied by a
 * service/marketing/transactional grant; this is the exact gap the insurance-vertical
 * conversation flagged), `feedback` (post-service satisfaction/review calls — split out from
 * `service` because it's soft-marketing-adjacent and commonly over-collected as if it were plain
 * service under DPDP).
 */
export type ConsentPurpose = "service" | "transactional" | "marketing" | "underwriting" | "feedback";

export type ConsentRecord = {
  /** e.164 phone number or email — whatever channel this consent was captured for. */
  dataPrincipal: string;
  purpose: ConsentPurpose;
  granted: boolean;
  grantedAt: Date;
  /** Optional hard expiry — null/undefined means no expiry (still subject to withdrawal). */
  expiresAt?: Date | null;
  /** Which consent notice/wording they agreed to — same "version alongside the record" pattern
   * as consent.ts's DISCLOSURE_VERSION, for the same reason: proving consent was granted isn't
   * enough without knowing what they actually agreed to. */
  version: string;
  channel: "shopify" | "ivr" | "web" | "import";
  /** Free-text: how it was captured (e.g. "checkout consent checkbox", "verbal on inbound call"). */
  source: string;
  withdrawnAt?: Date | null;
};

/**
 * Minimal surface the compliance package needs to enforce purpose-scoped consent. Many rows per
 * `dataPrincipal` (one per purpose, and a new row each time consent is re-granted after a prior
 * withdrawal — this is a ledger, not a single mutable row) — implement against your own storage,
 * see adapters/memory.ts for the simplest possible version.
 */
export type ConsentStorageAdapter = {
  /** True only if there's a granted, non-expired, non-withdrawn record for this exact purpose.
   * Consent for one purpose never satisfies a check for a different purpose — no fallback, no
   * "close enough" matching, by design. */
  hasConsent(dataPrincipal: string, purpose: ConsentPurpose): Promise<boolean>;
  grant(record: ConsentRecord): Promise<void>;
  /** Marks the most recent granted (non-already-withdrawn) record for this purpose as withdrawn.
   * Does not delete anything — the ledger keeps the full history including withdrawals, per the
   * 7-year consent-record retention requirement (kept separate from the underlying call-data
   * retention clock — see gdpr.ts's retention vs. this). After this resolves, `hasConsent` for
   * this exact purpose must return false until a new grant is recorded. */
  withdraw(dataPrincipal: string, purpose: ConsentPurpose): Promise<void>;
  listForPrincipal(dataPrincipal: string): Promise<ConsentRecord[]>;
};
