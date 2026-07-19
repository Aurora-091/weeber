/**
 * Per-org (optionally per-agent) intake-schema store — Phase 2 of the native
 * leads layer (docs/product-strategy/native-leads-layer-plan-2026-07-19.md §4,
 * Phase 2 item 7).
 *
 * Phase 1 shipped the intake schema as code-only per-vertical defaults
 * (intake-schema.ts). This module makes it merchant-editable: a row in
 * `leadIntakeSchemas` overrides the vertical default for an org (agentId null)
 * or a single agent (agentId set). Every read falls back to the vertical
 * default when no row exists, so nothing breaks for an org that never touches
 * the editor.
 *
 * COMPLIANCE (hard line, same as intake-schema.ts): a merchant CANNOT define a
 * regulated field. `validateSchemaDefs` drops any field whose key OR label
 * names a regulated identifier (SSN/PAN/Aadhaar/bank/full DOB/health/policy
 * financials) BEFORE it is persisted — so the editor can't become a backdoor
 * to collect what agents are forbidden to. The denylist is the single source
 * (REGULATED_FIELD_MARKERS); this is the write-side chokepoint, validateFields
 * is the read/ingest-side chokepoint.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../database";
import { leadIntakeSchemas } from "../../database/schema";
import { withRetry } from "../../database/with-retry";
import {
  defaultIntakeSchema,
  isRegulatedField,
  type LeadFieldDef,
  type LeadFieldType,
} from "./intake-schema";

const FIELD_TYPES: LeadFieldType[] = ["text", "number", "enum", "boolean", "date"];

/** A snake_case key, ≤ 64 chars, from a human label. Stable so the same label
 * maps to the same jsonb key across edits. */
function slugifyKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export type SchemaValidationResult = {
  /** Clean, de-duped, regulated-stripped field defs ready to persist. */
  valid: LeadFieldDef[];
  /** Keys/labels rejected for naming a regulated identifier (never their
   * values — these are field definitions, not data, but we still only surface
   * the offending key/label, consistent with the ingest path). */
  rejectedRegulated: string[];
};

/**
 * Sanitize a merchant-submitted field-definition list before persisting.
 * - regulated key/label → rejected (recorded, dropped)
 * - missing/blank key → derived from label; still blank → skipped
 * - unknown type → coerced to "text"
 * - enum with no options → downgraded to "text" (an empty dropdown is useless)
 * - duplicate keys → first wins
 * Never throws — returns what's safe to store plus what was rejected.
 */
export function validateSchemaDefs(input: unknown): SchemaValidationResult {
  const valid: LeadFieldDef[] = [];
  const rejectedRegulated: string[] = [];
  if (!Array.isArray(input)) return { valid, rejectedRegulated };

  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const key = (typeof r.key === "string" && r.key.trim() ? slugifyKey(r.key) : slugifyKey(label)) || "";
    if (!key || !label) continue;

    // The write-side compliance chokepoint — a merchant can't define what
    // agents are forbidden to collect.
    if (isRegulatedField(key, label)) {
      rejectedRegulated.push(key || label);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const type: LeadFieldType = FIELD_TYPES.includes(r.type as LeadFieldType) ? (r.type as LeadFieldType) : "text";
    const def: LeadFieldDef = { key, label, type };
    if (r.required === true) def.required = true;

    if (type === "enum") {
      const options = Array.isArray(r.options)
        ? r.options.map((o) => String(o).trim()).filter((o) => o.length > 0)
        : [];
      if (options.length === 0) {
        // An enum with no options can't render a real dropdown — store it as
        // free text rather than a broken control.
        def.type = "text";
      } else {
        def.options = [...new Set(options)].slice(0, 50);
      }
    }
    if (typeof r.piiClass === "string" && r.piiClass.trim()) def.piiClass = r.piiClass.trim();

    valid.push(def);
  }
  return { valid, rejectedRegulated };
}

/**
 * The effective intake schema for an org (and optionally a specific agent).
 * Resolution order: per-agent override → org default row → vertical default
 * (code). This is THE resolver every ingest path, promotion, manual add, Leads
 * page, and export must call so a custom schema takes effect everywhere at once.
 */
export async function resolveIntakeSchema(
  orgId: string,
  vertical: string | null | undefined,
  agentId?: number | null,
): Promise<LeadFieldDef[]> {
  // Per-agent override first, if asked for.
  if (agentId != null) {
    const [agentRow] = await db
      .select({ fields: leadIntakeSchemas.fields })
      .from(leadIntakeSchemas)
      .where(and(eq(leadIntakeSchemas.orgId, orgId), eq(leadIntakeSchemas.agentId, agentId)))
      .limit(1);
    if (agentRow && agentRow.fields.length > 0) return agentRow.fields as LeadFieldDef[];
  }

  // Org-wide default row (agentId null).
  const [orgRow] = await db
    .select({ fields: leadIntakeSchemas.fields })
    .from(leadIntakeSchemas)
    .where(and(eq(leadIntakeSchemas.orgId, orgId), isNull(leadIntakeSchemas.agentId)))
    .limit(1);
  if (orgRow && orgRow.fields.length > 0) return orgRow.fields as LeadFieldDef[];

  // Fall back to the code-defined vertical default.
  return defaultIntakeSchema(vertical);
}

export type OrgSchemaView = {
  fields: LeadFieldDef[];
  /** true = a stored per-org/agent override; false = the vertical default. */
  isCustom: boolean;
};

/** For the editor: the current effective schema plus whether it's a stored
 * override or the vertical default (so the UI can show "using default" and a
 * "reset to default" action). */
export async function getOrgIntakeSchema(
  orgId: string,
  vertical: string | null | undefined,
  agentId?: number | null,
): Promise<OrgSchemaView> {
  const where =
    agentId != null
      ? and(eq(leadIntakeSchemas.orgId, orgId), eq(leadIntakeSchemas.agentId, agentId))
      : and(eq(leadIntakeSchemas.orgId, orgId), isNull(leadIntakeSchemas.agentId));
  const [row] = await db.select({ fields: leadIntakeSchemas.fields }).from(leadIntakeSchemas).where(where).limit(1);
  if (row && row.fields.length > 0) return { fields: row.fields as LeadFieldDef[], isCustom: true };
  return { fields: defaultIntakeSchema(vertical), isCustom: false };
}

/**
 * Persist a per-org (or per-agent) schema override. Sanitizes first (regulated
 * fields stripped), then upserts on the (orgId, agentId) unique index. Returns
 * the stored fields plus any rejected regulated keys so the editor can warn.
 * An empty valid list resets to the vertical default (deletes the row) rather
 * than storing an empty schema that would render no columns.
 */
export async function setOrgIntakeSchema(
  orgId: string,
  input: unknown,
  agentId: number | null = null,
): Promise<{ fields: LeadFieldDef[]; rejectedRegulated: string[]; reset: boolean }> {
  const { valid, rejectedRegulated } = validateSchemaDefs(input);

  if (valid.length === 0) {
    await resetOrgIntakeSchema(orgId, agentId);
    return { fields: [], rejectedRegulated, reset: true };
  }

  // Explicit read-then-write rather than onConflictDoUpdate: the
  // (orgId, agentId) unique index does NOT catch the agentId=null case
  // (Postgres treats NULLs as distinct, so two org-default rows wouldn't
  // conflict), which would silently duplicate the org-wide default. Matching
  // on the same where clause the resolver uses keeps a single row per scope.
  const now = new Date();
  const where =
    agentId != null
      ? and(eq(leadIntakeSchemas.orgId, orgId), eq(leadIntakeSchemas.agentId, agentId))
      : and(eq(leadIntakeSchemas.orgId, orgId), isNull(leadIntakeSchemas.agentId));

  await withRetry(
    async () => {
      const [existing] = await db.select({ id: leadIntakeSchemas.id }).from(leadIntakeSchemas).where(where).limit(1);
      if (existing) {
        await db
          .update(leadIntakeSchemas)
          .set({ fields: valid, updatedAt: now })
          .where(eq(leadIntakeSchemas.id, existing.id));
      } else {
        await db.insert(leadIntakeSchemas).values({ orgId, agentId, fields: valid, createdAt: now, updatedAt: now });
      }
    },
    { label: "lead-intake-schema-upsert" },
  );
  return { fields: valid, rejectedRegulated, reset: false };
}

/** Remove a stored override so the org/agent falls back to the vertical
 * default. Idempotent — a no-op if none exists. */
export async function resetOrgIntakeSchema(orgId: string, agentId: number | null = null): Promise<void> {
  const where =
    agentId != null
      ? and(eq(leadIntakeSchemas.orgId, orgId), eq(leadIntakeSchemas.agentId, agentId))
      : and(eq(leadIntakeSchemas.orgId, orgId), isNull(leadIntakeSchemas.agentId));
  await db.delete(leadIntakeSchemas).where(where);
}
