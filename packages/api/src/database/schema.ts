import { pgTable, text, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

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
 * Rolling per-phone-number memory, alongside (not replacing) the per-call
 * `capturedState` engine — see ADR-023. One row per phone number: a flat
 * key/value overlay of facts learned across every call from/to that number,
 * merged (not replaced) on each call, so a returning caller doesn't start
 * from zero. Deliberately not a full call-history log — keeps prompt-
 * injection cost bounded no matter how many times someone's called.
 */
export const callerMemory = pgTable("caller_memory", {
  phoneNumber: text("phone_number").primaryKey(),
  facts: jsonb("facts").$type<Record<string, string>>().notNull().default({}),
  lastCallId: integer("last_call_id").references(() => calls.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
});

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
