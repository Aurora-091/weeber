import {
  pgTable,
  text,
  integer,
  numeric,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const adminAuditLog = pgTable("admin_audit_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("admin_audit_log_created_idx").on(table.createdAt),
]);

export const adminKeys = pgTable("admin_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  label: text("label").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});

export const agentTemplates = pgTable("agent_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vertical: text("vertical").notNull(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  defaultPersonaPrompt: text("default_persona_prompt"),
  // Latency fix (2026-07-16): the "Conversation Starter" line from each
  // template's script doc (docs/agent-prompts/*) is a fixed, deterministic
  // line — merge-tag variables only, not something that needs a fresh LLM
  // generation every call. When set (English only for v1) and every
  // {{merge_tag}} resolves from context (org name + capturedState),
  // stream.ts renders and speaks it directly (see speakCannedLine), skipping
  // the ~1.2s LLM time-to-first-token the greeting used to cost. Null (the
  // seed default for templates without a scripted opener, or any org that
  // has overridden its persona) falls back to the existing LLM-generated
  // greeting unchanged — this is additive, not a behavior change for those.
  literalGreetingTemplate: text("literal_greeting_template"),
  defaultTools: jsonb("default_tools").$type<unknown[]>().default([]),
  active: boolean("active").notNull().default(true),
  // Bespoke templates (2026-08-09): the catalog was implicitly global — every
  // active template for a vertical appeared for every org in that vertical.
  // A template written *for* one account (a pilot's own script, an agency's
  // own qualifying flow) has no business showing up in another merchant's
  // agent list, and its persona prompt is that account's IP.
  //   visibility = 'public'  -> catalog template, offered by vertical as before
  //   visibility = 'private' -> only offered to ownerOrgId
  // Default 'public' + null owner keeps every existing seeded row behaving
  // exactly as it does today (additive, no backfill needed). A private row
  // with a null ownerOrgId is offered to nobody, which is the safe direction
  // to fail.
  visibility: text("visibility").notNull().default("public"),
  ownerOrgId: text("owner_org_id").references(() => orgs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const broadcasts = pgTable("broadcasts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  audience: text("audience").notNull().default("all"),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
});

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name"),
  vertical: text("vertical").notNull().default("shopify"),
  planName: text("plan_name"),
  currency: text("currency"),
  countryCode: text("country_code"),
  timezone: text("timezone"),
  contactEmail: text("contact_email"),
  outboundNumber: text("outbound_number"),
  webhookUrl: text("webhook_url"),
  // Which provider is actually live for calls today — generalizes the
  // Twilio-only shape below to the BYO-per-provider pattern described in
  // docs/india-telephony.md ("orgs gains a telephonyProvider field").
  // Twilio is still the only one with a platform-owned (non-BYO)
  // provisioning path; Plivo/Exotel are BYO-only until a platform-account
  // path for either is prototyped.
  telephonyProvider: text("telephony_provider").notNull().default("twilio"),
  twilioMode: text("twilio_mode").notNull().default("platform"),
  twilioAccountSid: text("twilio_account_sid"),
  twilioAuthToken: text("twilio_auth_token"),
  // Plivo BYO — validated against Plivo's Account API before being stored
  // (see voice/plivo-provisioning.ts). No platform sub-account path yet.
  plivoAuthId: text("plivo_auth_id"),
  plivoAuthToken: text("plivo_auth_token"),
  // Exotel BYO — validated against Exotel's Accounts API before being
  // stored (see voice/exotel-provisioning.ts). `exotelSubdomain` because
  // Exotel's API host is region-specific per account (e.g. api.exotel.com,
  // api.in1.exotel.com), unlike Twilio/Plivo's single global host.
  exotelSid: text("exotel_sid"),
  exotelApiKey: text("exotel_api_key"),
  exotelApiToken: text("exotel_api_token"),
  exotelSubdomain: text("exotel_subdomain"),
  humanTransferNumber: text("human_transfer_number"),
  // Per-org, self-expiring "test mode" bypass. Bypasses the TCPA/TRAI
  // calling-window compliance check (voice/workflows/scheduler.ts and the
  // manual call-now path both read this) AND — as of 2026-07-19 — the two
  // insurance-vertical config gates (1600-series number series + producer
  // state licensing, voice/compliance/insurance-gates.ts) so a founder can
  // run a live phone demo to pilots before that paperwork is in place. DNC
  // and the FTSA attempt cap are NEVER bypassed, no exceptions, even in test
  // mode (2026-07-16 / 2026-07-19 explicit decisions). Null/past = test mode
  // off. Auto-expires rather than staying on indefinitely so it can't be
  // accidentally left on in production — set via
  // POST /api/app/compliance/test-mode, always to now()+24h.
  callingWindowTestModeUntil: timestamp("calling_window_test_mode_until", { withTimezone: true, mode: "date" }),
  // Org lifecycle (2026-07-20). `active` is the normal state; `suspended` is
  // a reversible pause the inactivity sweep applies after ORG_INACTIVITY_
  // SUSPEND_DAYS with no activity (its numbers are released so it stops
  // billing, but the org + subaccount can be reactivated); `closed` is the
  // terminal state — the Twilio subaccount has been permanently closed
  // (either by the sweep after ORG_INACTIVITY_CLOSE_DAYS, or by the user's
  // own "close account" action). See voice/twilio-provisioning.ts
  // (closeOrgTelephony) and voice/workflows/org-lifecycle-sweep.ts.
  status: text("status").notNull().default("active").$type<"active" | "suspended" | "closed">(),
  // Last time this org did anything that counts as "alive" — a call placed
  // or received, or a session bootstrap (/me). Drives the inactivity sweep.
  // Defaults to now() so freshly-created orgs aren't instantly swept.
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const calls = pgTable("calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // Which telephony provider actually carried this call. `twilioCallSid`
  // (below) is kept as the column name for the provider's own call
  // identifier regardless of provider — it was Twilio-only when named, but
  // is just an opaque string key today; renaming it would touch every call
  // site across the codebase for no functional benefit. See
  // voice/telephony-transport.ts for the provider-specific wire adapters.
  provider: text("provider").notNull().default("twilio"),
  twilioCallSid: text("twilio_call_sid").notNull().unique(),
  orgId: text("org_id"),
  direction: text("direction").notNull().$type<"inbound" | "outbound">(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  status: text("status").notNull().default("in-progress"),
  agentPersona: text("agent_persona"),
  recordingUrl: text("recording_url"),
  webhookUrl: text("webhook_url"),
  disposition: text("disposition"),
  /** Misc-5: post-call sentiment (positive/neutral/negative), captured by the
   * setDisposition tool call alongside disposition — teardown's recommended
   * "outcome, sentiment, next action" fields, sentiment was the missing one. */
  sentiment: text("sentiment"),
  /** Intent detection (2026-07-18) — WHY the caller called / what they want, distinct from
   * `disposition` (how the call ENDED). Captured by the setIntent tool, callable early once the
   * caller's purpose is clear, unlike setDisposition which the agent calls near the end. Flat,
   * vertical-agnostic taxonomy (see voice/tools/setIntent.ts's zod enum for the actual values) —
   * deliberately not a per-vertical enum to keep this simple; revisit only if the flat taxonomy
   * stops being descriptive enough for a real vertical's calls. */
  intent: text("intent"),
  sttReconnectCount: integer("stt_reconnect_count").default(0),
  // Cross-provider failover (2026-07-17, recommendation #1 of
  // docs/product-infra-and-gtm-report.md Part 4) — counts how many times
  // THIS call fell over to a different STT or TTS provider mid-call because
  // the active one hard-failed. 0 for the overwhelming majority of calls
  // (no outage hit); a nonzero value means the failover layer masked a
  // provider incident that would previously have ended the call outright.
  // Separate from sttReconnectCount above, which counts same-provider
  // reconnects (a transient network blip), not a provider swap.
  providerFailoverCount: integer("provider_failover_count").default(0),
  capturedState: jsonb("captured_state").$type<Record<string, string>>().default({}),
  // Global Compliance Engine Tier 0 (2026-07-16, docs/global-compliance-engine-plan.md #2/#3):
  // the exact recording/AI disclosure text + version resolved and embedded into this call's
  // agent prompt. Nullable — a call finalized before this column existed, or one whose
  // disclosure-persist update raced/failed (fire-and-forget, doesn't block the call), simply
  // has no record here rather than a misleading default. `disclosureVersion` is either
  // consent.ts's DISCLOSURE_VERSION constant (a built-in, language-matched line) or the literal
  // string "custom" (an explicit override / env var was used instead — see resolveDisclosure).
  disclosureText: text("disclosure_text"),
  disclosureVersion: text("disclosure_version"),
  // ADR-062 (2026-07-30): when the disclosure/opening turn actually fired on
  // this call — the "what was disclosed and *when*" audit answer, read from
  // canonical state rather than inferred from transcript timestamps. Written
  // best-effort right after the greeting turn is spoken (see stream.ts
  // runGreeting); a call whose greeting never ran, or one finalized before
  // this column existed, simply has null here rather than a misleading guess.
  // `disclosureText`/`disclosureVersion` above say WHAT was configured; this
  // says WHETHER/WHEN it was actually delivered. The transcript substring
  // check in @weeber/compliance's audit-trail.ts stays as a content fallback.
  disclosureFiredAt: timestamp("disclosure_fired_at", { withTimezone: true, mode: "date" }),
  // Per-call cost visibility (2026-07-18, India feature-gap analysis Phase 3):
  // the STT/TTS/LLM providers *actually used* for this specific call, snapshotted
  // at call time — not looked up from current org config, which can change after
  // the call happened and would misattribute cost to whatever's configured today.
  // Nullable: a call finalized before this column existed, or a test/preview
  // call with no provider ever resolved, simply has no record here.
  sttProviderUsed: text("stt_provider_used"),
  ttsProviderUsed: text("tts_provider_used"),
  llmProviderUsed: text("llm_provider_used"),
  // Estimated cost in US cents (a float — e.g. 12.34 means ~$0.1234) for this
  // call, computed once at finalizeCall from durationSeconds (endedAt -
  // startedAt) and the providers above — see voice/cost-estimate.ts.
  // Explicitly an ESTIMATE, not a reconciled bill: real per-minute rates vary
  // by plan/volume, and LLM cost in particular is a flat per-minute
  // approximation since actual token usage isn't tracked per real call yet
  // (only in the test-chat preview endpoint) — surfaced to merchants as
  // "~$X" for exactly that reason, never as an exact invoice line. Null
  // until the call is finalized, or if duration/providers are unknown
  // (never silently defaults to 0, which would look like a genuinely free
  // call).
  estimatedCostUsdCents: real("estimated_cost_usd_cents"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  // Native Leads layer (2026-07-19, docs/product-strategy/native-leads-layer-plan-2026-07-19.md).
  // The deduped person-of-record this call belongs to. Set at finalizeCall by promoteLeadFromCall,
  // which upserts a `leads` row keyed on (orgId, phone) and links it back here. Nullable: a call
  // finalized before this column existed, a call with no resolvable human number, or one whose
  // lead-promotion raced/failed (best-effort, doesn't block finalize) simply has no lead link.
  leadId: integer("lead_id"),
  // Call-health verdict (Five Bets Phase II, 2026-07-31, see voice/call-health.ts).
  // `status` alone says how the call ENDED from telephony's view; these say
  // whether the caller actually got a working agent. Derived at finalizeCall
  // from latency + turn + transcript signals by classifyCallHealth and written
  // best-effort (never blocks finalize). Nullable: a call finalized before
  // these columns existed, or one whose health-write raced/failed, simply has
  // null here rather than a misleading "healthy". `healthReasons` is the
  // human-readable list backing the verdict (empty array for a clean call).
  healthStatus: text("health_status").$type<"healthy" | "degraded" | "silent-failure">(),
  healthReasons: jsonb("health_reasons").$type<string[]>(),
}, (table) => [
  index("calls_org_id_idx").on(table.orgId),
  index("calls_lead_id_idx").on(table.leadId),
  index("calls_health_status_idx").on(table.healthStatus),
]);

export const callLatency = pgTable("call_latency", {
  callId: integer("call_id").primaryKey().references(() => calls.id, { onDelete: "cascade" }),
  sttConnectMs: integer("stt_connect_ms"),
  llmTtftMs: integer("llm_ttft_ms"),
  ttsFirstByteMs: integer("tts_first_byte_ms"),
  /** Caller-perceived "pickup to first word" latency (2026-07-17 follow-up
   * to audit #01's D7 finding: this exact gap — session setup + the
   * greeting's own STT/LLM/TTS work combined — was previously unmeasured).
   * Measured from the moment the media stream's "start" event arrives
   * (as close as this codebase gets to "call answered") to the greeting's
   * first TTS audio byte. Unlike sttConnectMs/llmTtftMs/ttsFirstByteMs
   * (each one pipeline stage), this is the actual end-to-end number a
   * caller experiences as "dead air before the agent speaks" — the metric
   * the "why is there a 5-10s pause on outbound calls" complaint is about. */
  pickupToFirstAudioMs: integer("pickup_to_first_audio_ms"),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

/**
 * Per-TURN latency (as opposed to callLatency above, which is per-CALL and
 * only ever captures the first-ever value of each metric across the whole
 * call). A call is many turns; the founder-facing question is "how fast
 * does it respond, typically" — that needs a distribution across every
 * turn of every call, not just each call's first turn, since later turns
 * can be slower (longer history, a tool call, etc.) and a single
 * first-turn number would hide that.
 *
 * `voiceToVoiceMs` is the metric that actually matters to a caller: from
 * the moment the STT provider declares they've stopped talking
 * (`speechFinal`, captured as `turnStartedAt` in stream.ts) to the first
 * byte of TTS audio going back out. `llmTtftMs`/`ttsFirstByteMs` are the
 * two components of that budget, kept separately so a regression can be
 * attributed to the right stage. Greeting turns (not triggered by caller
 * speech) still get a row for their llm/tts components, but
 * `voiceToVoiceMs` is null for them — there's no caller-stopped-talking
 * instant to measure from.
 */
export const turnLatency = pgTable("turn_latency", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  llmTtftMs: integer("llm_ttft_ms"),
  ttsFirstByteMs: integer("tts_first_byte_ms"),
  voiceToVoiceMs: integer("voice_to_voice_ms"),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("turn_latency_call_id_idx").on(table.callId),
  index("turn_latency_captured_at_idx").on(table.capturedAt),
]);

export const callerMemory = pgTable("caller_memory", {
  orgId: text("org_id").notNull().default(""),
  phoneNumber: text("phone_number").notNull(),
  facts: jsonb("facts").$type<Record<string, string>>().notNull().default({}),
  lastCallId: integer("last_call_id").references(() => calls.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.phoneNumber] }),
]);

export const doNotCall = pgTable("do_not_call", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  phoneNumber: text("phone_number").notNull().unique(),
  reason: text("reason"),
  source: text("source").default("manual"),
  addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

/**
 * Consent ledger (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #6) — backs @weeber/compliance's ConsentStorageAdapter.
 * Replaces shopifyContacts.marketingConsent's single boolean with a real, purpose-scoped,
 * append-only ledger: many rows per (orgId, dataPrincipal, purpose), one new row each time
 * consent is granted or re-granted, withdrawals recorded via `withdrawnAt` rather than deleting
 * the row (the ledger keeps its full history, including withdrawals).
 *
 * 7-year retention on this table (DPDP consent-record requirement) — deliberately NOT wired into
 * gdpr.ts's purge sweep, which targets `calls`. Proof-of-consent metadata (this table) and the
 * underlying call/recording data (`calls`, purged on GDPR's shorter data-minimization clock) are
 * two different retention windows on purpose — see docs/global-compliance-engine-plan.md Tier 1
 * #10 for why they have to be split rather than sharing one retention number.
 *
 * Backfill note (not yet run): existing `shopifyContacts.marketingConsent = true` rows should
 * migrate into this table as one row per contact with `purpose = 'marketing'`, `channel =
 * 'shopify'`, `source = 'backfilled from shopify_contacts.marketing_consent'` — a one-time data
 * migration, not part of this schema change itself. Do this before wiring any real dial-time
 * `hasConsent('marketing')` check into a live Shopify workflow, or every existing consented
 * contact would suddenly look unconsented.
 */
export const consentRecords = pgTable("consent_records", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** e.164 phone number or email — whatever channel this consent was captured for. */
  dataPrincipal: text("data_principal").notNull(),
  purpose: text("purpose", { enum: ["service", "transactional", "marketing", "underwriting", "feedback"] }).notNull(),
  granted: boolean("granted").notNull().default(true),
  grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  /** Which consent notice/wording they agreed to — same "version alongside the record" pattern as
   * consent.ts's DISCLOSURE_VERSION and calls.disclosureVersion. */
  version: text("version").notNull(),
  channel: text("channel", { enum: ["shopify", "ivr", "web", "import"] }).notNull(),
  source: text("source").notNull(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("consent_records_org_principal_purpose_idx").on(table.orgId, table.dataPrincipal, table.purpose),
]);

/**
 * Per-call opt-out events (ADR-062, 2026-07-30) — the "did they opt out on
 * this call" audit answer. Distinct from `doNotCall` (the current, point-in-time
 * list state) because an opt-out is a call-time FACT that stays true even if the
 * number is later removed from the DNC list, and a number can also land on the
 * DNC list for reasons unrelated to a specific call. Written when the agent
 * records a cancellation/opt-out intent (see voice/stream.ts's setIntent hook);
 * `dncPropagatedAt` is stamped if/when that opt-out is pushed onto the DNC list,
 * so the audit trail can show both the request and the follow-through. Append-only
 * — never updated except to fill in `dncPropagatedAt`.
 */
export const optOutEvents = pgTable("opt_out_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
  orgId: text("org_id"),
  phoneNumber: text("phone_number").notNull(),
  /** The phrase/tool signal that triggered the opt-out, if captured (e.g. the intent notes) — null when only the fact was recorded. */
  triggerPhrase: text("trigger_phrase"),
  firedAt: timestamp("fired_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  /** When this opt-out was propagated to the Do-Not-Call list, if it was — null means not (yet) scrubbed. */
  dncPropagatedAt: timestamp("dnc_propagated_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("opt_out_events_call_id_idx").on(table.callId),
  index("opt_out_events_phone_number_idx").on(table.phoneNumber),
]);

/**
 * Phase I (five-bets build plan, 2026-07-31) — guardrail moments as first-class,
 * queryable data. Until now a "guardrail held" was only *inferred* by scanning
 * `toolCalls` for `flagGuardrailEvent` (the agent's own self-report) or
 * `guardrail-heuristic-detector` (stream.ts's independent prompt-injection
 * check). That gives a count but no durable per-event record — no exportable
 * compliance artifact, no trend, no detail column. This table promotes those
 * moments to a row per event, mirroring the opt_out_events precedent (ADR-062):
 * the tool-call log stays as-is (unchanged, still the raw breadcrumb), and this
 * is written best-effort alongside it in stream.ts's logToolCall. Append-only.
 *
 * `source` distinguishes the model's own self-report from the heuristic
 * detector; `detail` is the agent's one-line "what/how" for a self-report, or
 * the triggering caller text for a heuristic hit (null if neither was captured).
 */
export const guardrailEvents = pgTable("guardrail_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
  orgId: text("org_id"),
  category: text("category", {
    enum: ["topic-boundary", "unauthorized-promise", "prompt-injection", "abuse", "unknown"],
  }).notNull(),
  source: text("source", { enum: ["agent-self-report", "heuristic-detector"] }).notNull(),
  /** The agent's one-sentence "what the caller asked / how I handled it" (self-report), or the
   * triggering caller phrase (heuristic detector) — null when neither was captured. */
  detail: text("detail"),
  firedAt: timestamp("fired_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("guardrail_events_call_id_idx").on(table.callId),
  index("guardrail_events_org_fired_idx").on(table.orgId, table.firedAt),
]);

export const featureFlags = pgTable("feature_flags", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: text("key").notNull(),
  orgId: text("org_id").notNull().default(""),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("feature_flags_key_org_idx").on(table.key, table.orgId),
]);

export const orgAgentConfigs = pgTable("org_agent_configs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  templateKey: text("template_key").notNull(),
  personaPrompt: text("persona_prompt"),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name"),
  greetingLine: text("greeting_line"),
  closingLine: text("closing_line"),
  toneStyle: text("tone_style"),
  voiceProvider: text("voice_provider"),
  voiceId: text("voice_id"),
  language: text("language"),
  sttProvider: text("stt_provider"),
  llmProvider: text("llm_provider"),
  llmModel: text("llm_model"),
  // Cross-provider failover (2026-07-17, recommendation #1 of
  // docs/product-infra-and-gtm-report.md Part 4) — per-agent override of the
  // fallback order tried when the primary provider above hard-fails
  // mid-call. Nullable: null means "use the platform default chain" (see
  // DEFAULT_STT_FALLBACK_ORDER/DEFAULT_TTS_FALLBACK_ORDER in
  // voice/failover.ts), so existing agents get sane behavior with zero
  // config. When set, this is the *complete* ordered list of providers to
  // try after the primary fails (the primary itself, sttProvider/
  // voiceProvider above, is never included — resolveFailoverChain filters
  // it out even if a caller accidentally lists it). Values outside the
  // provider's real enum are dropped rather than erroring, same
  // fail-open philosophy as the rest of this table's per-agent overrides.
  sttFallbackOrder: jsonb("stt_fallback_order").$type<string[]>(),
  ttsFallbackOrder: jsonb("tts_fallback_order").$type<string[]>(),
  // Same idea for the LLM — a list of AI Gateway model ids to add to
  // providerOptions.gateway.models alongside llmModel/GATEWAY_MODEL above.
  // Null means "use AI_GATEWAY_FALLBACK_MODELS env var" (platform default).
  llmFallbackModels: jsonb("llm_fallback_models").$type<string[]>(),
  toolsEnabled: jsonb("tools_enabled").$type<unknown[]>(),
  guardrails: jsonb("guardrails").$type<Record<string, unknown>>(),
  // Per-org retry cadence overrides (issue 3 feature) — nullable = "use the
  // platform default" (see integrations/shopify/routes.ts's
  // SHOPIFY_*_DELAY_MINUTES/SHOPIFY_*_MAX_ATTEMPTS env vars for what those
  // defaults are). Three explicit knobs, deliberately no customer-driven
  // reschedule override on top of these — user's own call. firstCallDelayMinutes
  // controls the delay before the very first call for this template;
  // retryDelayMinutes controls the gap between a no-answer/busy/failed
  // outcome and the next attempt (read by workflows/engine.ts's org-scoped
  // retry path, not the global WORKFLOWS env var); maxAttempts caps total
  // attempts for both.
  firstCallDelayMinutes: integer("first_call_delay_minutes"),
  retryDelayMinutes: integer("retry_delay_minutes"),
  maxAttempts: integer("max_attempts"),
  // C2b: which of the org's owned numbers this agent calls from — nullable,
  // falls back to the org's primary active org_phone_numbers row (or the
  // legacy orgs.outboundNumber, for orgs that predate this table) when
  // unset, so nothing breaks for single-number orgs. See
  // resolveOutboundNumberForAgent in voice/org-queries.ts.
  phoneNumberId: integer("phone_number_id").references(() => orgPhoneNumbers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("org_agent_configs_org_key_idx").on(table.orgId, table.templateKey),
]);

/**
 * C2b — Number provisioning. Replaces the single orgs.outboundNumber column
 * (kept, untouched, as the legacy fallback for orgs that never adopt this)
 * with a real one-org-owns-N-numbers model, from any provider. Every
 * assign/deassign/decommission flow reads and writes this table, never
 * orgs.outboundNumber directly, going forward.
 */
export const orgPhoneNumbers = pgTable("org_phone_numbers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["twilio", "plivo", "exotel"] }).notNull(),
  phoneNumber: text("phone_number").notNull(),
  status: text("status", { enum: ["active", "released"] }).notNull().default("active"),
  // Insurance vertical India/US iteration (2026-07-16,
  // docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #1): which TRAI
  // number series this number is registered under. "1600" is the TRAI/IRDAI-mandated series for
  // BFSI (banking/insurance/etc) service & transactional calls in India — distinct from the
  // general 140 (promotional)/160 (transactional) series most orgs use. Nullable/optional for
  // every non-insurance org and for orgs outside India — this column only matters when
  // checkInsuranceNumberSeriesCompliance actually evaluates it.
  numberSeries: text("number_series", { enum: ["140", "160", "1600"] }),
  purchasedAt: timestamp("purchased_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("org_phone_numbers_org_id_idx").on(table.orgId),
]);

/**
 * Insurance vertical India/US iteration (2026-07-16,
 * docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #2) — backs
 * checkInsuranceProducerLicensing. A US insurance producer must be licensed in the state where the
 * prospect resides; nothing enforced that before this. One row per licensed advisor an org
 * transfers calls to (today org-level, not per-specific-agent-config, since `orgs.humanTransferNumber`
 * is a single number per org — matches the existing granularity of that field).
 *
 * `source` distinguishes how `licensedStates`/`linesOfAuthority` were populated: `"manual"` (an
 * admin/merchant typed them in — the MVP path, ships without any external dependency) vs.
 * `"nipr"` (pulled from the National Insurance Producer Registry's Producer Database via NPN —
 * the industry-standard real-time source every compliance vendor in this space, AgentSync/
 * Sircon/TrustLayer, ultimately wraps; not integrated yet, `npn` + `lastVerifiedAt` are here so
 * that upgrade doesn't need a schema change later).
 */
export const insuranceAdvisors = pgTable("insurance_advisors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** National Producer Number — the NIPR-wide identifier for a licensed producer. Null until/
   * unless the NIPR integration is wired up; not required for the manual-entry MVP path. */
  npn: text("npn"),
  licensedStates: jsonb("licensed_states").$type<string[]>().notNull().default([]),
  linesOfAuthority: jsonb("lines_of_authority").$type<string[] | null>(),
  source: text("source", { enum: ["manual", "nipr"] }).notNull().default("manual"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("insurance_advisors_org_id_idx").on(table.orgId),
]);

// One row per org, drives the dashboard "finish setup" checklist + the
// setup modal's resume/skip state. Steps are free-form jsonb (not one
// column per step) so the vertical-specific step set can change without a
// migration — see docs/DECISIONS.md "Setup modal, not a setup page".
export const onboardingState = pgTable("onboarding_state", {
  orgId: text("org_id").primaryKey().references(() => orgs.id, { onDelete: "cascade" }),
  steps: jsonb("steps").$type<Record<string, boolean>>().notNull().default({}),
  dismissed: boolean("dismissed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const orgMembers = pgTable("org_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  supabaseUserId: text("supabase_user_id").notNull(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  // Placeholder for a Phase 2 team feature, NOT a live role model: the unique
  // index below means one membership per user, and the only insert site
  // (app/routes.ts resolveOrCreateMembership) hardcodes "owner". Every value
  // in this column is "owner" and can only be "owner" today, so every
  // `role !== "owner"` check in the codebase is currently unreachable.
  // Unlike platform_admins.role below, this is deliberately left unconstrained
  // — the role vocabulary isn't decided yet, and guessing it in a CHECK would
  // be a migration to undo later. See ADR-080.
  role: text("role").notNull().default("owner"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  // Real uniqueness on the user alone (audit#03 P1 fix) -- the product model is one org per
  // user, and resolveOrCreateMembership's race-safety (routes.ts) depends on THIS constraint,
  // not the old composite one below. Two concurrent first-logins each generate a different
  // random orgId before inserting, so a composite (user, org) key never actually conflicts
  // between them -- only a standalone unique constraint on the user catches that race.
  uniqueIndex("org_members_user_idx").on(table.supabaseUserId),
]);


export const scheduledCalls = pgTable("scheduled_calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  toNumber: text("to_number").notNull(),
  workflowName: text("workflow_name").notNull(),
  persona: text("persona"),
  webhookUrl: text("webhook_url"),
  attempt: integer("attempt").notNull().default(1),
  maxAttempts: integer("max_attempts").notNull().default(1),
  runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull(),
  status: text("status").notNull().default("pending"),
  orgId: text("org_id"),
  checkoutToken: text("checkout_token"),
  recoveredOrderId: text("recovered_order_id"),
  // Money, not free text — attributed order value from Shopify's `total_price`.
  // Postgres `numeric` preserves decimal precision exactly (no float drift) and
  // makes the column SQL-aggregatable. Drizzle returns it as a string, so the
  // existing defensive `Number.parseFloat` read path in org-queries.ts is
  // unchanged. Requires a generated migration (text -> numeric) before deploy.
  recoveredAmount: numeric("recovered_amount", { precision: 12, scale: 2 }),
  metadata: jsonb("metadata").$type<Record<string, string | number>>(),
  workflowRunId: text("workflow_run_id"),
  // Why the last dispatch attempt didn't go out (2026-07-19). The scheduler's
  // dispatchScheduledCall returns a rich {reason, detail} on every block, but
  // until now the sweep only wrote `status` and discarded the reason to a
  // console.warn — leaving merchants (and admins) with a "trigger detected,
  // no call ever happened" mystery and no way to self-diagnose. These three
  // columns persist that reason so the Orders page (merchant) and the admin
  // compliance view can show WHY. `lastBlockReason` is one of the
  // DispatchResult reason enum values (dnc / calling_window / attempt_cap /
  // insurance_number_series / insurance_producer_licensing /
  // india_number_series / place_failed); `lastBlockDetail` is the
  // human-readable sentence; `blockedAt` is when it was last recorded.
  // Cleared back to null on a successful dispatch so a deferred-then-succeeded
  // row never shows a stale reason.
  lastBlockReason: text("last_block_reason"),
  lastBlockDetail: text("last_block_detail"),
  blockedAt: timestamp("blocked_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("scheduled_calls_checkout_token_idx").on(table.checkoutToken),
  index("scheduled_calls_org_id_idx").on(table.orgId),
  index("scheduled_calls_status_run_at_idx").on(table.status, table.runAt),
  index("scheduled_calls_workflow_run_id_idx").on(table.workflowRunId),
]);

export const shopLinks = pgTable("shop_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shop: text("shop").notNull().unique(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  scopes: text("scopes"),
  connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true, mode: "date" }),
});

export const shopifyContacts = pgTable("shopify_contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  shop: text("shop").notNull(),
  e164: text("e164").notNull(),
  email: text("email"),
  name: text("name"),
  marketingConsent: boolean("marketing_consent").default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("shopify_contacts_org_e164_idx").on(table.orgId, table.e164),
]);

export const shopifyDiscountCodes = pgTable("shopify_discount_codes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shop: text("shop").notNull(),
  code: text("code").notNull().unique(),
  checkoutToken: text("checkout_token"),
  discountId: text("discount_id"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const shopifyWebhookEvents = pgTable("shopify_webhook_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shop: text("shop").notNull(),
  topic: text("topic").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("shopify_webhook_events_dedupe_idx").on(table.shop, table.topic, table.idempotencyKey),
]);

export const twilioStatusEvents = pgTable("twilio_status_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callSid: text("call_sid").notNull(),
  status: text("status").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("twilio_status_events_sid_status_idx").on(table.callSid, table.status),
]);

export const supportTickets = pgTable("support_tickets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id"),
  email: text("email").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const supportReplies = pgTable("support_replies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  ticketId: integer("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  sentBy: text("sent_by").notNull(),
  emailSent: boolean("email_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("support_replies_ticket_id_idx").on(table.ticketId),
]);

export const toolCalls = pgTable("tool_calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const transcripts = pgTable("transcripts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
  role: text("role").notNull().$type<"agent" | "caller">(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("transcripts_call_id_idx").on(table.callId),
]);

export const waitlistSignups = pgTable("waitlist_signups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull().unique(),
  name: text("name"),
  referralCode: text("referral_code"),
  source: text("source"),
  convertedOrgId: text("converted_org_id"),
  ownReferralCode: text("own_referral_code").unique(),
  referralCount: integer("referral_count").notNull().default(0),
  phone: text("phone"),
  unsubscribed: boolean("unsubscribed").notNull().default(false),
  unsubscribeToken: text("unsubscribe_token").unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

// --- Platform Settings (key-value, admin-managed) ---

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

// --- Platform Admins (allowlist for dashboard SSO) ---

export const platformAdmins = pgTable("platform_admins", {
  email: text("email").primaryKey(),
  role: text("role").notNull().default("superadmin"),
  addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  // Mirrors Vocalist's platform_role CHECK constraint shape (5 roles), even
  // though only "superadmin" is actually enforced anywhere today (same as
  // Vocalist only checking "super_admin" of its 5). Guards against a typo'd
  // role value silently granting/denying access, cheap insurance either way.
  check("platform_admins_role_check", sql`${table.role} in ('superadmin', 'admin', 'support', 'finance', 'developer')`),
]);

// --- Workflow Canvas (graph-based execution engine) ---

export const workflowTemplates = pgTable("workflow_templates", {
  id: text("id").primaryKey(),
  vertical: text("vertical").notNull(),
  name: text("name").notNull(),
  // Merchant-facing "what does this flow do" copy shown on the workflows list
  // card (2026-07-19). Empty-string default so pre-existing rows and any
  // admin-created template without copy render cleanly instead of "undefined".
  description: text("description").notNull().default(""),
  graph: jsonb("graph").notNull().$type<import("../voice/workflows/graph-types").WorkflowGraph>(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
});

export const orgWorkflowConfigs = pgTable("org_workflow_configs", {
  orgId: text("org_id").notNull(),
  templateKey: text("template_key").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  overrides: jsonb("overrides").$type<Record<string, Record<string, unknown>>>(),
  // Workflow Canvas v4 (2026-07-18, Phase 1) — an org's own fully-owned graph,
  // either forked from the template or built from the locked-scaffold blank
  // starting point (see voice/workflows/scaffold.ts). Null (the common case
  // today) means the org runs the template's graph unchanged, exactly as
  // before this column existed. Set means the engine reads this graph
  // instead of the template's — see graph-engine.ts's resolution order.
  // Every save is validated server-side (scaffold.ts's
  // validateLockedNodesEnforced) before being written here — a merchant
  // can't save a graph that routes any call/sms action around the
  // locked DNC/calling-window nodes, even via a direct API call.
  customGraph: jsonb("custom_graph").$type<import("../voice/workflows/graph-types").WorkflowGraph>(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.templateKey] }),
]);

export const workflowRuns = pgTable("workflow_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id"),
  templateKey: text("template_key").notNull(),
  context: jsonb("context").notNull().$type<Record<string, string | number>>(),
  currentNodeId: text("current_node_id").notNull(),
  status: text("status", { enum: ["running", "waiting", "completed", "failed"] }).notNull().default("running"),
  version: integer("version").notNull().default(1),
  // Workflow analytics overlay (2026-07-16, docs/workflow-canvas-architecture.md's Option A,
  // informed by researching ElevenLabs' and Bolna's graph-agent analytics/debugging features).
  // Append-only log of every node this run has entered, in order — `currentNodeId` alone only
  // ever tells you where a run IS right now, not the full path it took to get there or how long
  // it spent at each stop, so per-node entry counts/avg-time-in-node/termination breakdowns were
  // not previously computable from this table at all. Each entry: {nodeId, enteredAt (ISO
  // string)}. Appended via a jsonb `||` concat in graph-engine.ts, not a stale read-then-write, to
  // avoid a race between concurrent scheduler ticks touching the same run.
  nodeHistory: jsonb("node_history").notNull().default([]).$type<Array<{ nodeId: string; enteredAt: string }>>(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("workflow_runs_org_id_idx").on(table.orgId),
  index("workflow_runs_status_next_run_at_idx").on(table.status, table.nextRunAt),
  index("workflow_runs_template_key_idx").on(table.templateKey),
]);

/**
 * A3b — Knowledge Base source documents (PDF/URL/pasted text) a merchant
 * uploads per org. Ingestion (voice/knowledge-base.ts) chunks + embeds the
 * extracted text into `knowledgeChunks`; this row just tracks the source
 * and ingestion status.
 */
export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sourceType: text("source_type", { enum: ["text", "url", "pdf"] }).notNull(),
  sourceUrl: text("source_url"),
  status: text("status", { enum: ["processing", "ready", "failed"] }).notNull().default("processing"),
  errorMessage: text("error_message"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("knowledge_documents_org_id_idx").on(table.orgId),
]);

/**
 * One embedded chunk of a knowledge document. `embedding` is stored as a
 * plain jsonb number array rather than a pgvector column deliberately —
 * avoids a hard dependency on the pgvector extension being enabled (not
 * guaranteed on every Postgres/Supabase project, and irrelevant at the
 * per-org chunk counts this feature will see for a long time). Retrieval
 * does an in-memory cosine-similarity scan per org (see
 * voice/knowledge-base.ts's searchKnowledgeBase) — brute-force is fine at
 * hundreds-to-low-thousands of chunks; revisit with a real vector index
 * only if that stops being true.
 */
export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  chunkText: text("chunk_text").notNull(),
  embedding: jsonb("embedding").$type<number[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("knowledge_chunks_org_id_idx").on(table.orgId),
  index("knowledge_chunks_document_id_idx").on(table.documentId),
]);

/**
 * Per-org external integration credentials (CRM, Calendar, etc.).
 * Each row stores one provider's credentials for one org. The provider column
 * identifies which integration (gohighlevel, salesforce, hubspot, google_calendar),
 * and `credentials` is a JSON blob with provider-specific fields (API keys, access tokens).
 * Only one row per org+provider pair — unique constraint enforces this.
 */
export const orgIntegrations = pgTable("org_integrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull(),
  provider: text("provider").notNull(),
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("org_integrations_org_provider_idx").on(table.orgId, table.provider),
]);

export const webhookOutbox = pgTable("webhook_outbox", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  targetUrl: text("target_url").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  alertedAt: timestamp("alerted_at", { withTimezone: true, mode: "date" }),
});

/**
 * Native Leads / Records layer (2026-07-19,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md).
 *
 * The person-of-record. One row per (orgId, phone) — a deduped human, NOT one
 * row per call/cart (that's `scheduledCalls`) or one row per raw capture
 * (that's `calls.capturedState`). Every inbound source (agent calls, web
 * forms, client CRMs, Pipedream) funnels through `POST /api/leads/ingest`
 * into this table; every outbound sink (Excel export, native CRM adapters)
 * reads from it. The DB is the source of truth — external tools attach at the
 * edges, never in the middle.
 *
 * `fields` is validated against the org's lead intake schema
 * (`leadIntakeSchemas`, falling back to the vertical default) on every ingest
 * path, and regulated fields (SSN/PAN/Aadhaar/bank/full DOB/health/exact
 * policy financials) are BLOCKED at that validation layer regardless of
 * source — the same regulatory boundary the agents enforce, so this layer
 * can't become a backdoor for what agents are forbidden to collect.
 */
export const leads = pgTable("leads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull(),
  // Dedup key with orgId. E.164-ish as captured; normalization is the caller's
  // job before ingest so the unique index actually catches duplicates.
  phone: text("phone").notNull(),
  name: text("name"),
  // Structured, schema-validated captured fields (see leadIntakeSchemas). The
  // keys here are the intake schema's defined keys, not the LLM's free-form
  // capturedState keys — capturedState is promoted INTO here at finalizeCall.
  fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
  // Pipeline. Fixed enum in v1 (per-org configurable deferred). Manual in v1 —
  // not auto-advanced from call dispositions yet (an open question in the plan).
  status: text("status", {
    enum: ["new", "contacted", "qualified", "booked", "closed", "lost"],
  }).notNull().default("new"),
  // How this lead first entered the layer. `call` = promoted from an agent
  // call; the rest are ingest sources.
  source: text("source", {
    enum: ["call", "form", "webhook", "pipedream", "crm", "manual"],
  }).notNull().default("manual"),
  // Licensed advisor this lead is assigned to (insurance). References
  // insuranceAdvisors, not org_members — advisors are a distinct compliance
  // record (licensed states / lines of authority). Nullable = unassigned.
  assignedAdvisorId: integer("assigned_advisor_id"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  // The dedup/upsert key — one lead per person per org.
  uniqueIndex("leads_org_phone_idx").on(table.orgId, table.phone),
  index("leads_org_status_idx").on(table.orgId, table.status),
]);

/**
 * Per-org (optionally per-agent) lead intake field definitions — "what should
 * this agent collect?". Falls back to the vertical default (see
 * voice/leads/intake-schema.ts) when no row exists. `fields` is the ordered
 * field-definition list ({ key, label, type, required, piiClass }); the Leads
 * page renders these as real columns/sections, and ingest validates against
 * them. The schema editor (Phase 2) refuses regulated fields.
 */
export const leadIntakeSchemas = pgTable("lead_intake_schemas", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull(),
  // Null = the org-wide default. Non-null = an override for one agent config.
  agentId: integer("agent_id"),
  fields: jsonb("fields").$type<
    { key: string; label: string; type: "text" | "number" | "enum" | "boolean" | "date"; required?: boolean; options?: string[]; piiClass?: string }[]
  >().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("lead_intake_schemas_org_agent_idx").on(table.orgId, table.agentId),
]);

/**
 * Per-org scoped API keys for the lead ingest contract (POST /api/leads/ingest).
 * Safe to hand to a client's form/CRM/Pipedream: scoped to one org, revocable,
 * and can never read another org's data. Same generation/hashing shape as
 * adminKeys (SHA-256 of a high-entropy token, plaintext returned exactly once),
 * but org-scoped and ingest-only rather than full dashboard auth.
 */
export const leadApiKeys = pgTable("lead_api_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull(),
  label: text("label").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("lead_api_keys_org_id_idx").on(table.orgId),
]);

/**
 * Per-org outbound-call rate-limit window (audit 2026-07-19 finding #2). Replaces the old
 * process-local module-singleton limiter (`voice/middleware/rate-limit.ts`), which was global
 * across every org (one aggressive org could throttle everyone) and reset on every restart.
 *
 * One row per org — a fixed-window counter, reset-or-increment done in a single atomic UPSERT
 * (see `voice/middleware/rate-limit.ts`) so concurrent requests can't race past the limit.
 * Postgres-backed rather than Redis: the audit's own "even a Postgres-backed counter is enough
 * at current scale" call, and it means the limiter works with zero extra infra/config (unlike
 * `session-store.ts`'s Redis-optional pattern, which only activates when `REDIS_URL` is set).
 */
export const outboundRateLimitWindows = pgTable("outbound_rate_limit_windows", {
  orgId: text("org_id").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
  callCount: integer("call_count").notNull().default(0),
});

/**
 * First-party product-usage telemetry (2026-07-31). Append-only stream of
 * client-emitted UI events — the first thing that tells us how merchants
 * actually use the product, starting with the workflow canvas / Customize
 * flow (which was a complete black box before this). NOT marketing analytics
 * (that's GTM/GA4, injected only on the public site via tracking-scripts.tsx)
 * and NOT the admin action log (`admin_audit_log`); this is merchant product
 * behavior, owned first-party so it stays queryable in our own Postgres with
 * no third-party data processor — a deliberate fit for a compliance-sensitive
 * product at pre-pilot volume. Chosen over PostHog/Amplitude: zero new vendor
 * cost, no PII leaving, and the questions are few and known (activation
 * funnel, is-the-canvas-used, AI-draft usage, validator friction, time-to-
 * activate). The stream exports to any analytics tool later if volume ever
 * justifies it.
 *
 * `name` is a client-owned event name (canonical typed union lives in the web
 * package's lib/analytics.ts; the ingest route validates shape defensively
 * with a regex + size caps rather than a shared runtime allowlist, to keep the
 * server decoupled from the browser bundle). `props` is the event-specific
 * payload. `occurredAt` is the client's event time (events are batched and may
 * be flushed seconds later); `createdAt` is server receipt time.
 */
export const productEvents = pgTable("product_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  name: text("name").notNull(),
  props: jsonb("props").$type<Record<string, unknown>>(),
  sessionId: text("session_id"),
  path: text("path"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("product_events_name_created_idx").on(table.name, table.createdAt),
  index("product_events_org_created_idx").on(table.orgId, table.createdAt),
]);

