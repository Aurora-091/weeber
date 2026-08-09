/**
 * Lead Intake Schema (2026-07-19,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md §4/§5).
 *
 * `captureField` lets the LLM write free-form snake_case keys into
 * `calls.capturedState` — great for in-call memory, useless as a structured
 * leads table (you can't render columns for keys you don't know exist). The
 * intake schema is the defined field set the leads layer promotes into and
 * renders: per-vertical default here, per-org/per-agent override later
 * (leadIntakeSchemas table, Phase 2 editor).
 *
 * COMPLIANCE (hard line): regulated fields are BLOCKED at this validation
 * layer on EVERY ingest path (agent call, form, webhook, Pipedream) — the
 * same regulatory boundary the agents enforce, so the leads layer can't
 * become a backdoor collecting what agents are forbidden to. This is a
 * denylist by key-substring + label-substring, plus an allowlist-shaped
 * schema (only defined keys are accepted; unknown keys are dropped, not
 * stored blindly).
 */

export type LeadFieldType = "text" | "number" | "enum" | "boolean" | "date";

export type LeadFieldDef = {
  key: string;
  label: string;
  type: LeadFieldType;
  required?: boolean;
  /** For `enum` — allowed values. */
  options?: string[];
  /** Non-regulated PII class hint for the UI (e.g. "contact"). Regulated
   * classes never appear here because those fields are blocked outright. */
  piiClass?: string;
};

/**
 * Regulated / forbidden field markers. If a field's key OR label contains any
 * of these (case-insensitive substring), the field is rejected at validation
 * time regardless of the source. Deliberately broad — false-positives (a
 * blocked field a merchant genuinely wanted) are recoverable via support;
 * a silent leak of a regulated identifier is not.
 */
export const REGULATED_FIELD_MARKERS: string[] = [
  "ssn",
  "social security",
  "pan", // Indian Permanent Account Number
  "aadhaar",
  "aadhar",
  "passport",
  "driver_license",
  "drivers_license",
  "driving_licence",
  "bank",
  "account_number",
  "acct_number",
  "routing",
  "ifsc",
  "iban",
  "card_number",
  "credit_card",
  "debit_card",
  "cvv",
  "date_of_birth",
  "dob",
  "birth_date",
  "birthdate",
  "health",
  "medical",
  "diagnosis",
  "disease",
  "condition",
  "medication",
  "policy_number",
  "premium_amount",
  "sum_assured",
  "salary",
  "income",
  "net_worth",
];

/** True when this key/label pair names a regulated field that must never be stored. */
export function isRegulatedField(key: string, label = ""): boolean {
  const haystack = `${key} ${label}`.toLowerCase();
  return REGULATED_FIELD_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Insurance default intake schema (§5) — non-regulated, genuinely useful for a
 * licensed-advisor handoff. Editable per-org later; this is the starting set.
 */
const INSURANCE_DEFAULT: LeadFieldDef[] = [
  { key: "full_name", label: "Full name", type: "text", piiClass: "contact" },
  { key: "city", label: "City", type: "text", piiClass: "contact" },
  // State/region (2026-08-09): licensure is state-scoped in the US, so which
  // state a lead sits in decides whether there is a licensed advisor who may
  // legally take the transfer at all — it is routing data, not decoration.
  // Free text rather than an enum: this has to hold US states AND Indian
  // states, and an out-of-options enum value is stored anyway (see coerce).
  { key: "state", label: "State / region", type: "text", piiClass: "contact" },
  {
    key: "product_interest",
    label: "Product interest",
    type: "enum",
    options: ["term", "health", "motor", "life", "final_expense", "travel", "other"],
  },
  // `interest_area` is the phrase the agent SAYS ("you'd recently reached out
  // about final expense coverage"), which is not the same thing as
  // `product_interest`, the enum the leads table filters and reports on.
  //
  // This field was missing entirely (2026-08-09) while three outbound
  // templates opened with {{interest_area}}. Because validateFields drops
  // keys that aren't in the schema, no ingest path could ever land it, the
  // unresolved-tag guard rejected the opener, and every one of those calls
  // silently fell back to an LLM-improvised greeting — the exact failure
  // ADR-085 set out to fix, one layer further down than it looked.
  //
  // Kept free text and deliberately generic: it is read aloud verbatim to a
  // consumer, so it must never carry a plan name, a carrier, or a number.
  { key: "interest_area", label: "Interest area (spoken)", type: "text" },
  { key: "existing_policy", label: "Already covered?", type: "boolean" },
  {
    key: "budget_band",
    label: "Budget band",
    type: "enum",
    // Rough bands only — NOT exact financials (those are regulated/blocked).
    options: ["<1k", "1k-3k", "3k-10k", "10k+"],
  },
  { key: "best_callback_time", label: "Best callback time", type: "text" },
  {
    key: "preferred_language",
    label: "Preferred language",
    type: "enum",
    options: ["en", "hi", "hinglish"],
  },
  { key: "lead_notes", label: "Notes", type: "text" },
];

/**
 * Shopify default intake schema — minimal for now. Orders migrates onto the
 * generic layer in Phase 3; until then this exists so a Shopify org's ingest
 * calls have a valid (non-empty) schema to validate against.
 */
const SHOPIFY_DEFAULT: LeadFieldDef[] = [
  { key: "full_name", label: "Full name", type: "text", piiClass: "contact" },
  { key: "email", label: "Email", type: "text", piiClass: "contact" },
  { key: "order_id", label: "Order ID", type: "text" },
  { key: "product_interest", label: "Product interest", type: "text" },
  { key: "best_callback_time", label: "Best callback time", type: "text" },
  { key: "lead_notes", label: "Notes", type: "text" },
];

const DEFAULT_SCHEMAS: Record<string, LeadFieldDef[]> = {
  insurance: INSURANCE_DEFAULT,
  shopify: SHOPIFY_DEFAULT,
};

/** The vertical's default intake schema. Unknown verticals fall back to a
 * name + notes minimum so ingest never has a null schema to validate against. */
export function defaultIntakeSchema(vertical: string | null | undefined): LeadFieldDef[] {
  return (
    DEFAULT_SCHEMAS[vertical ?? ""] ?? [
      { key: "full_name", label: "Full name", type: "text", piiClass: "contact" },
      { key: "lead_notes", label: "Notes", type: "text" },
    ]
  );
}

export type ValidateResult = {
  /** Only the keys defined in the schema, coerced to their declared type as a
   * string. Unknown keys are dropped (not an error — sources over-send). */
  accepted: Record<string, string>;
  /** Keys rejected because they matched a regulated marker. Their VALUES are
   * never returned or logged — only the offending keys, so the caller can
   * tell the source it sent something forbidden without echoing the secret. */
  rejectedRegulated: string[];
  /** Keys dropped because they aren't in the schema at all (informational). */
  droppedUnknown: string[];
};

/**
 * Validate an incoming `fields` object against a schema. Never throws on bad
 * data — returns what was accepted and what was rejected so the ingest
 * endpoint can decide (accept-with-warnings vs hard-reject). Regulated fields
 * are ALWAYS rejected; this is the single chokepoint every source flows
 * through.
 */
export function validateFields(
  incoming: Record<string, unknown> | null | undefined,
  schema: LeadFieldDef[],
): ValidateResult {
  const accepted: Record<string, string> = {};
  const rejectedRegulated: string[] = [];
  const droppedUnknown: string[] = [];
  if (!incoming || typeof incoming !== "object") {
    return { accepted, rejectedRegulated, droppedUnknown };
  }

  const byKey = new Map(schema.map((f) => [f.key, f]));

  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = rawKey.trim();
    if (!key) continue;

    const def = byKey.get(key);
    const label = def?.label ?? "";

    // Regulated check runs on EVERY key — even one not in the schema — so a
    // source can't smuggle a regulated field through by not declaring it.
    if (isRegulatedField(key, label)) {
      rejectedRegulated.push(key);
      continue;
    }

    if (!def) {
      droppedUnknown.push(key);
      continue;
    }

    if (rawValue === null || rawValue === undefined) continue;
    accepted[key] = coerce(rawValue, def);
  }

  return { accepted, rejectedRegulated, droppedUnknown };
}

/** Everything is stored as a string (the `fields` jsonb is Record<string,string>).
 * Coercion just normalizes obvious types into their string form; it never
 * throws — an out-of-options enum value is still stored (surfaced in the UI),
 * because rejecting mid-call data would lose information the advisor wants. */
function coerce(value: unknown, def: LeadFieldDef): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const str = String(value).trim();
  if (def.type === "boolean") {
    const lowered = str.toLowerCase();
    if (["true", "yes", "y", "1"].includes(lowered)) return "true";
    if (["false", "no", "n", "0"].includes(lowered)) return "false";
  }
  return str;
}
