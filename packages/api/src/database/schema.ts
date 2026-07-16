import {
  pgTable,
  text,
  integer,
  numeric,
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
  // Per-org, self-expiring "test mode" that bypasses ONLY the TCPA/TRAI
  // calling-window compliance check (voice/workflows/scheduler.ts and the
  // new manual call-now path both read this) — DNC is never bypassed, no
  // exceptions, even in test mode (2026-07-16 explicit decision). Null/past
  // = test mode off. Auto-expires rather than staying on indefinitely so
  // it can't be accidentally left on in production — set via
  // POST /api/app/compliance/test-mode, always to now()+24h.
  callingWindowTestModeUntil: timestamp("calling_window_test_mode_until", { withTimezone: true, mode: "date" }),
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
  sttReconnectCount: integer("stt_reconnect_count").default(0),
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
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("calls_org_id_idx").on(table.orgId),
]);

export const callLatency = pgTable("call_latency", {
  callId: integer("call_id").primaryKey().references(() => calls.id, { onDelete: "cascade" }),
  sttConnectMs: integer("stt_connect_ms"),
  llmTtftMs: integer("llm_ttft_ms"),
  ttsFirstByteMs: integer("tts_first_byte_ms"),
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
 * docs/global-compliance-engine-plan.md #6) — backs @openvent/compliance's ConsentStorageAdapter.
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
  purchasedAt: timestamp("purchased_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("org_phone_numbers_org_id_idx").on(table.orgId),
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
