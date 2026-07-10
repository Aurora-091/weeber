import { pgTable, text, integer, boolean, timestamp, jsonb, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";

export const calls = pgTable("calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  twilioCallSid: text("twilio_call_sid").notNull().unique(),
  /**
   * Weeber org-lite scoping (additive, nullable) — see ADR-030. Null for
   * plain self-hosted OpenVent usage (single-operator, no org concept).
   * Populated for Weeber calls so the dashboard can eventually filter by
   * org without a data migration once full multi-tenant UI is built.
   */
  orgId: text("org_id"),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  status: text("status").notNull().default("in-progress"),
  agentPersona: text("agent_persona"),
  recordingUrl: text("recording_url"),
  webhookUrl: text("webhook_url"),
  disposition: text("disposition"),
  sttReconnectCount: integer("stt_reconnect_count").default(0),
  /**
   * Structured call state — deterministic key/value facts the agent has
   * confirmed during this call (email, order ID, name, etc), captured via
   * the `captureField` tool (see voice/tools/captureField.ts). This is the
   * single source of truth the agent reads back each turn, separate from
   * the raw transcript — fixes the "asks for the same info twice" failure
   * mode that plain transcript/summary-based memory has. See ADR-012.
   */
  capturedState: jsonb("captured_state").$type<Record<string, string>>().default({}),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
});

/**
 * Per-call latency breakdown — one row per call, filled in as each metric
 * becomes available during the call and finalized at call end (see
 * stream.ts's finalizeCall). All three columns are nullable: a call that
 * ended before a given stage was reached (or shipped before this table
 * existed) simply has no value for it, not a zero or an error. See ADR-022.
 */
export const callLatency = pgTable("call_latency", {
  callId: integer("call_id")
    .primaryKey()
    .references(() => calls.id, { onDelete: "cascade" }),
  /** Time from opening the Deepgram STT socket to it reporting ready (first connect only, not reconnects). */
  sttConnectMs: integer("stt_connect_ms"),
  /** Time-to-first-token from the LLM, captured on the first turn that produces one (usually the greeting). */
  llmTtftMs: integer("llm_ttft_ms"),
  /** Time from sending text to the TTS provider to receiving the first audio chunk back, first turn only. */
  ttsFirstByteMs: integer("tts_first_byte_ms"),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Rolling per-org, per-phone-number memory, alongside (not replacing) the
 * per-call `capturedState` engine — see ADR-023. One row per (org, phone
 * number): a flat key/value overlay of facts learned across every call from/
 * to that number *for that org*, merged (not replaced) on each call, so a
 * returning caller doesn't start from zero. Deliberately not a full
 * call-history log — keeps prompt-injection cost bounded no matter how many
 * times someone's called.
 *
 * `orgId` scoping added post-launch (audit #01, D2): a phone number is not a
 * unique identity across the whole system — the same person can call two
 * different Weeber merchants, and each merchant is a separate data
 * controller. Before this fix, memory (and GDPR erasure of that memory) was
 * keyed on phone number alone, so a redact request from Merchant A silently
 * wiped Merchant B's memory of the same caller too. `orgId` defaults to `""`
 * (not `NULL`) specifically so the composite primary key and the upsert's
 * `onConflictDoUpdate` target both work correctly for self-hosted OpenVent
 * usage (no org concept) — Postgres treats `NULL` as distinct from itself in
 * uniqueness checks, which would silently defeat the upsert. `""` is the
 * "no org" sentinel here, equivalent in meaning to `calls.orgId IS NULL`
 * elsewhere in this schema.
 */
export const callerMemory = pgTable(
  "caller_memory",
  {
    orgId: text("org_id").notNull().default(""),
    phoneNumber: text("phone_number").notNull(),
    facts: jsonb("facts").$type<Record<string, string>>().notNull().default({}),
    lastCallId: integer("last_call_id").references(() => calls.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.phoneNumber] })],
);

/**
 * Multi-user dashboard auth (ADR-025) — labeled API keys, not real accounts.
 * The legacy single `ADMIN_API_KEY` env var keeps working unchanged and
 * forever (it's the bootstrap key); this table is an additive way to hand
 * out additional, individually revocable keys (e.g. "Jane's laptop", "n8n
 * webhook") without rotating the one shared secret for everyone. Only the
 * hash is ever stored — the plaintext key is shown exactly once, at
 * creation, and is not retrievable again.
 */
export const adminKeys = pgTable("admin_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  label: text("label").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});

export const transcripts = pgTable("transcripts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["caller", "agent"] }).notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const toolCalls = pgTable("tool_calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  callId: integer("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Internal Do-Not-Call list, checked automatically before every outbound call
 * (enforced via the @openvent/compliance package, see voice/compliance/adapters.ts). Numbers land here either manually
 * (POST /api/voice/dnc) or automatically via a workflow action (e.g. the
 * agent marks a call "not-interested" and a workflow adds the number here).
 */
export const doNotCall = pgTable("do_not_call", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  phoneNumber: text("phone_number").notNull().unique(),
  reason: text("reason"),
  source: text("source", { enum: ["manual", "agent", "national-registry"] }).default("manual"),
  addedAt: timestamp("added_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Scheduled follow-up calls/actions driven by workflow configs (see
 * voice/workflows/) — e.g. a "no-answer" outcome scheduling a retry call
 * later. Polled periodically by a background sweep.
 */
export const scheduledCalls = pgTable("scheduled_calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  toNumber: text("to_number").notNull(),
  workflowName: text("workflow_name").notNull(),
  persona: text("persona"),
  webhookUrl: text("webhook_url"),
  attempt: integer("attempt").notNull().default(1),
  maxAttempts: integer("max_attempts").notNull().default(1),
  runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull(),
  status: text("status", { enum: ["pending", "claimed", "executed", "canceled", "failed"] })
    .notNull()
    .default("pending"),
  /**
   * Weeber org-lite scoping (additive, nullable) — see ADR-030.
   */
  orgId: text("org_id"),
  /**
   * Promoted checkoutToken column (nullable, indexed).
   */
  checkoutToken: text("checkout_token"),
  /**
   * Additive recovered order ID and amount (nullable).
   */
  recoveredOrderId: text("recovered_order_id"),
  recoveredAmount: text("recovered_amount"),
  /**
   * Free-form workflow context (additive, nullable) — e.g. the Shopify
   * vertical stores { shop, checkoutToken, orderId } here so the call
   * flow's tools (offerDiscount, confirmOrder, cancelOrder) know which
   * Shopify entity they're acting on without a schema change per vertical.
   * Generic on purpose — any future vertical/workflow can use this the
   * same way instead of growing this table's column count per feature.
   */
  metadata: jsonb("metadata").$type<Record<string, string | number>>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("scheduled_calls_checkout_token_idx").on(table.checkoutToken)
]);

/**
 * --- Weeber multi-org-lite + Shopify vertical (ADR-030) ---
 *
 * Deliberately lightweight: an org is just an id + display metadata, not a
 * full tenant-isolation model (no per-org Twilio sub-account, no per-org
 * DNC list, no per-org billing entity yet — see WEEBER-PLAN.md "Phase 2"
 * for what's deferred and why). This is enough to (a) not leak one
 * merchant's calls/contacts into another's queries and (b) not require a
 * second painful migration when full tenant isolation gets built later.
 */
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name"),
  /**
   * Vertical-agnostic data model, Shopify-only UI for now (ADR-031). Not
   * enforced by an enum at the DB level on purpose — new verticals
   * (clinic, hotel) shouldn't need a schema migration to exist, just a new
   * value here and a new row in `agentTemplates`.
   */
  vertical: text("vertical").notNull().default("shopify"),
  planName: text("plan_name"),
  currency: text("currency"),
  countryCode: text("country_code"),
  timezone: text("timezone"),
  contactEmail: text("contact_email"),
  outboundNumber: text("outbound_number"),
  /**
   * Real human/merchant phone number the `transferToHuman` tool dials into
   * when the agent hands a live call off — see voice/tools/transferToHuman.ts.
   * Falls back to the HUMAN_TRANSFER_NUMBER env var when unset, same
   * override-then-env-fallback pattern as `outboundNumber`.
   */
  humanTransferNumber: text("human_transfer_number"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * One row per connected Shopify shop. Mirrors weebersh's own `ShopOrgLink`
 * table (docs/contract.md endpoint 1) — Weeber needs the same shop -> org
 * lookup on its side, since every inbound webhook payload from weebersh
 * carries `shop`, not `org_id`, after the initial /connected call. One org
 * can own multiple shops (matches weebersh's model).
 */
export const shopLinks = pgTable("shop_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shop: text("shop").notNull().unique(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  scopes: text("scopes"),
  connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true, mode: "date" }),
});

/**
 * Upserted from the customers/create|update webhook (contract endpoint 5).
 * Idempotent by (orgId, e164) per the contract. `marketingConsent` is
 * mapped from Shopify's `marketing_consent` field — this is a data point
 * for the compliance layer, not a replacement for it; TCPA/DNC checks
 * still run per-call via @openvent/compliance regardless of this flag.
 */
export const shopifyContacts = pgTable(
  "shopify_contacts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    shop: text("shop").notNull(),
    e164: text("e164").notNull(),
    email: text("email"),
    name: text("name"),
    marketingConsent: boolean("marketing_consent").default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("shopify_contacts_org_e164_idx").on(table.orgId, table.e164)],
);

/**
 * Idempotency ledger for discount codes Weeber asks weebersh to create
 * (contract endpoint 11 — POST /discounts/create). The contract requires a
 * stable, retry-safe code (not a fresh random one per retry); this table is
 * what makes "have we already issued a code for this checkout?" a lookup
 * instead of a re-derivation.
 */
export const shopifyDiscountCodes = pgTable("shopify_discount_codes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shop: text("shop").notNull(),
  code: text("code").notNull().unique(),
  checkoutToken: text("checkout_token"),
  discountId: text("discount_id"),
  status: text("status", { enum: ["pending", "created", "already_exists", "failed"] })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Idempotency ledger for inbound Shopify webhooks forwarded by weebersh.
 * The contract is explicit that delivery is at-least-once and every
 * endpoint must be idempotent (Shopify retries + weebersh's own retries) —
 * this table is the shared mechanism every Shopify route checks before
 * acting, instead of each route inventing its own dedupe logic.
 */
export const shopifyWebhookEvents = pgTable(
  "shopify_webhook_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    shop: text("shop").notNull(),
    topic: text("topic").notNull(),
    /** e.g. checkout token, order id, or customer id depending on topic — whatever the contract names as the idempotency key for that endpoint. */
    idempotencyKey: text("idempotency_key").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("shopify_webhook_events_dedupe_idx").on(table.shop, table.topic, table.idempotencyKey)],
);

/**
 * Agent template catalog (ADR-031) — backs the admin panel's "Agent
 * template catalog" feature and is the concrete seam for the
 * vertical-agnostic data model: a new vertical (clinic, hotel) adds rows
 * here, not a schema change. `key` is the stable identifier a
 * `scheduledCalls.workflowName`/persona lookup resolves against (e.g.
 * "shopify-cart-recovery"); `defaultTools` names which voice tools this
 * template wires up, resolved to actual tool implementations in code, not
 * stored as code here.
 */
export const agentTemplates = pgTable("agent_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vertical: text("vertical").notNull(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  defaultPersonaPrompt: text("default_persona_prompt"),
  defaultTools: jsonb("default_tools").$type<string[]>().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const orgAgentConfigs = pgTable(
  "org_agent_configs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    personaPrompt: text("persona_prompt"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * The agent "frame" (2026-07-10) — a fixed, structured set of fields a
     * merchant (or later, an AI agent-builder prompt) configures per agent,
     * instead of hand-writing a whole new persona/prompt/tool-wiring from
     * scratch each time. See voice/agent-frame.ts for the shared schema/
     * types both the dashboard form and any future AI builder use, and
     * agent.ts's `resolveAgentConfig` for how these compose into an actual
     * system prompt + runtime overrides. All nullable/additive — an existing
     * row with none of these set behaves exactly as before (falls through
     * to `personaPrompt`/template defaults and global env-configured
     * voice/LLM/tools, unchanged).
     */
    name: text("name"),
    greetingLine: text("greeting_line"),
    closingLine: text("closing_line"),
    toneStyle: text("tone_style"),
    voiceProvider: text("voice_provider"),
    voiceId: text("voice_id"),
    language: text("language"),
    /** STT provider override (2026-07-10) — see agent-frame.ts's `sttProvider`. */
    sttProvider: text("stt_provider"),
    llmProvider: text("llm_provider"),
    llmModel: text("llm_model"),
    toolsEnabled: jsonb("tools_enabled").$type<string[]>(),
    guardrails: jsonb("guardrails").$type<{
      topicBoundaryStrictness?: "low" | "medium" | "high";
      injectionSensitivity?: "low" | "medium" | "high";
      abuseHandlingEnabled?: boolean;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("org_agent_configs_org_key_idx").on(table.orgId, table.templateKey),
  ]
);

/**
 * Merchant login → org resolution (frontend round, 2026-07-10). One row per
 * membership: a Supabase Auth user (by `sub` claim) belonging to an org with
 * a role. Today the product creates exactly one org per user with role
 * "owner", but the shape deliberately supports multi-org-per-user and richer
 * roles (WEEBER-PLAN workstream Q) without a migration — the v1 UI just
 * picks the first membership.
 */
export const orgMembers = pgTable(
  "org_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    supabaseUserId: text("supabase_user_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    /** Opportunistically written by requireMerchantSession on each authenticated
     * request (best-effort, cheap) — avoids a separate live Supabase Admin API
     * call just to list users for the admin panel's Users page. Nullable: a
     * member row created before this column existed, or one whose token has
     * never carried an email claim, simply shows blank until their next request. */
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("org_members_user_org_idx").on(table.supabaseUserId, table.orgId),
    index("org_members_user_idx").on(table.supabaseUserId),
  ],
);

/**
 * Pre-launch/marketing waitlist signups — the landing page's one real
 * conversion action. `email` unique so a repeat signup is a no-op, not a
 * duplicate row. `convertedOrgId` is set once (manually, for now) if/when a
 * waitlisted email actually becomes a real org — lets Marketing Analytics
 * show a real conversion count instead of just raw signup volume.
 */
export const waitlistSignups = pgTable("waitlist_signups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull().unique(),
  name: text("name"),
  referralCode: text("referral_code"),
  source: text("source"),
  convertedOrgId: text("converted_org_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Admin-authored broadcasts to merchants or the whole waitlist. `status`
 * stays "queued" (not "sent") when no email provider is configured
 * (RESEND_API_KEY unset) — the row is real, honest about what actually
 * happened, never a fabricated "sent" for something that didn't go out.
 */
export const broadcasts = pgTable("broadcasts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** "all" (every org) | "waitlist" | a specific orgId */
  audience: text("audience").notNull().default("all"),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
});

/**
 * Merchant support tickets — submitted from `/app` (authenticated) or the
 * public landing page (email-only, no account required yet). `orgId`
 * nullable for the latter case.
 */
export const supportTickets = pgTable("support_tickets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id"),
  email: text("email").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Generic admin-action audit log — the Logs admin page reads this, not raw
 * server/process logs (no log-shipping infra exists, and this is more
 * useful anyway: "who changed what," not stack traces). Append-only,
 * same spirit as impersonationSessions' audit trail.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("admin_audit_log_created_idx").on(table.createdAt)],
);

/**
 * Feature flags — deliberately the simplest possible model (admin panel
 * scope, CLAUDE-BUILD-BRIEF §4.5): a key that's either global or scoped to
 * one org, on or off. `orgId` uses the same `""`-as-global sentinel trick as
 * `callerMemory.orgId` (Postgres treats NULL as distinct from itself in
 * unique indexes, which would let duplicate global flags slip through).
 * Effective value for an org = org-scoped row if present, else global row,
 * else false.
 */
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    key: text("key").notNull(),
    /** `""` = global flag; otherwise an orgs.id */
    orgId: text("org_id").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("feature_flags_key_org_idx").on(table.key, table.orgId)],
);

/**
 * Merchant-impersonation sessions — session store and append-only audit log
 * in one (CLAUDE-BUILD-BRIEF §4.6's hard requirement: every impersonation is
 * audit-logged, who/which org/start/end). Modeled on the compliance
 * package's audit-trail principles (append-only, queryable, exportable)
 * without touching that package. Rows are never deleted; the only mutation
 * ever allowed is setting `endedAt`/`endedReason` once. The plaintext token
 * is returned exactly once at /impersonation/start and only its hash is
 * stored — same discipline as `adminKeys.keyHash`.
 */
export const impersonationSessions = pgTable(
  "impersonation_sessions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Which admin key started it — the labeled key's label, or "env-admin-key". */
    adminActor: text("admin_actor").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    endedReason: text("ended_reason", { enum: ["stopped", "expired"] }),
  },
  (table) => [index("impersonation_sessions_org_idx").on(table.orgId)],
);
