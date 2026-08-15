/**
 * The inbound lead contract — POST /api/leads/ingest (2026-07-19,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md §7).
 *
 * The single most important thing in v1: one contract every inbound source
 * calls (agent calls promote directly in-process; web forms, client CRMs, and
 * Pipedream all POST here). Get this right and every future source is free —
 * no source is special-cased into the core.
 *
 * Auth: a per-org lead API key (Authorization: Bearer wlk_... or X-Api-Key).
 * The key resolves to exactly one org; that's the ONLY org the request can
 * write to. Deliberately its own router (not the user-session app), so "what
 * an external, key-authed caller can reach" stays a single small file.
 *
 * Behavior: validate `fields` against the org's intake schema (regulated keys
 * rejected — same boundary the agents enforce), upsert by (orgId, phone) so a
 * retrying source converges instead of duplicating, source-tag the row, return
 * the lead id. Independently testable with no external dependency — this is why
 * v1 isn't blocked on Pipedream infra.
 */
import { Hono } from "hono";
import { getOrg } from "../org-queries";
import { resolveLeadApiKey } from "./api-keys";
import { validateFields } from "./intake-schema";
import { resolveIntakeSchema } from "./schema-store";
import { upsertLead, type LeadSource } from "./leads";
import { planCsvImport, summarizePlan, normalizePhone } from "./csv-import";

const INGEST_SOURCES: LeadSource[] = ["form", "webhook", "pipedream", "crm", "manual"];

/** Hard ceiling on an uploaded CSV. A lead list is small; anything past this is
 * either a mistake or a different problem (streamed import), and a multi-MB
 * string parsed in one pass on the request path is not free. */
const MAX_CSV_BYTES = 5 * 1024 * 1024;

function extractKey(authHeader: string | undefined, apiKeyHeader: string | undefined): string | null {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  if (apiKeyHeader?.trim()) return apiKeyHeader.trim();
  return null;
}

export const leadsIngest = new Hono()
  .post("/ingest", async (c) => {
    const key = extractKey(c.req.header("Authorization"), c.req.header("X-Api-Key"));
    if (!key) {
      return c.json({ error: "Missing API key. Send it as `Authorization: Bearer <key>` or `X-Api-Key`." }, 401);
    }

    const resolved = await resolveLeadApiKey(key);
    if (!resolved) {
      return c.json({ error: "Invalid or revoked API key." }, 401);
    }
    const orgId = resolved.orgId;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON object body." }, 400);
    }

    const { phone, name, fields, source, externalId, triggerWorkflow } = body as {
      phone?: unknown;
      name?: unknown;
      fields?: unknown;
      source?: unknown;
      externalId?: unknown;
      triggerWorkflow?: unknown;
    };

    if (typeof phone !== "string" || !phone.trim()) {
      return c.json({ error: "`phone` is required (string). Normalize to E.164 before sending for reliable dedup." }, 400);
    }

    // Source-tag the row. Callers should say where the lead came from; default
    // to `webhook` (the generic external-POST case) rather than guessing.
    const resolvedSource: LeadSource =
      typeof source === "string" && (INGEST_SOURCES as string[]).includes(source) ? (source as LeadSource) : "webhook";

    const org = await getOrg(orgId);
    // Per-org override if the merchant configured one (Phase 2), else the
    // vertical default. Same resolver the Leads page + promotion + export use,
    // so a custom schema takes effect on every ingest immediately.
    const schema = await resolveIntakeSchema(orgId, org?.vertical);
    const { accepted, rejectedRegulated, droppedUnknown } = validateFields(
      fields as Record<string, unknown> | null | undefined,
      schema,
    );

    // Bug fix (2026-08-15, pilot latency audit F1): the docstring above has
    // always told integrators to send E.164, but nothing enforced it — a raw
    // "(415) 555-1234" was stored as-is. `getLeadGreetingContext` does an
    // exact match against the E.164 number the telephony provider reports, so
    // a non-normalized row here can never be found at call time; the caller
    // pays the full LLM-greeting latency (~1.3-1.9s TTFT) with no error or
    // signal that the lead data even existed. Normalizing at the door — with
    // the org's configured country code as the fallback for a bare national
    // number — makes this endpoint match the CSV bulk-import path, which
    // already normalized.
    const normalizedPhone = normalizePhone(phone.trim(), org?.countryCode ?? undefined);
    if (!normalizedPhone) {
      return c.json(
        {
          error: `Could not parse "${phone.trim()}" as a phone number. Send E.164 (e.g. +14155551234), or set this org's default country code.`,
        },
        400,
      );
    }

    const { id, created } = await upsertLead({
      orgId,
      phone: normalizedPhone,
      name: typeof name === "string" ? name : null,
      fields: accepted,
      source: resolvedSource,
    });

    // triggerWorkflow is accepted in the contract but not wired in v1 — an
    // ingest-triggered call must first respect the same DNC/TCPA/quiet-hours
    // dial-gates as agent-initiated calls (plan §12). Acknowledge rather than
    // silently ignore, so an integrator knows it's coming, not broken.
    const workflowNote = triggerWorkflow
      ? "triggerWorkflow is not yet supported — coming once ingest-triggered calls are wired through the compliance dial-gates."
      : undefined;

    return c.json(
      {
        ok: true,
        leadId: id,
        created,
        // externalId is echoed for the caller's own reconciliation. Idempotency
        // is already guaranteed by the (orgId, phone) upsert, so a retry with
        // the same phone converges on this same leadId rather than duplicating.
        externalId: typeof externalId === "string" ? externalId : undefined,
        // Surface what was NOT stored so an integrator can fix their payload —
        // regulated keys are named (never their values), unknown keys listed.
        rejectedRegulated: rejectedRegulated.length ? rejectedRegulated : undefined,
        droppedUnknown: droppedUnknown.length ? droppedUnknown : undefined,
        note: workflowNote,
      },
      created ? 201 : 200,
    );
  })
  /**
   * POST /ingest/csv — spreadsheet import, preview-first.
   *
   * `dryRun` defaults to TRUE. That default is the feature: the way a CSV import
   * goes wrong is a header row that does not match the intake schema, and
   * `validateFields` drops unknown keys silently by design, so a mismatched file
   * imports "fine" as a list of bare phone numbers and you find out on a live
   * call. You have to ask for the write, having seen the per-column mapping.
   *
   * Accepts multipart/form-data (`file`, plus optional `dryRun`,
   * `defaultCountryCode`, `source` fields) or a raw text/csv body with the same
   * options as query params.
   */
  .post("/ingest/csv", async (c) => {
    const key = extractKey(c.req.header("Authorization"), c.req.header("X-Api-Key"));
    if (!key) {
      return c.json({ error: "Missing API key. Send it as `Authorization: Bearer <key>` or `X-Api-Key`." }, 401);
    }
    const resolved = await resolveLeadApiKey(key);
    if (!resolved) {
      return c.json({ error: "Invalid or revoked API key." }, 401);
    }
    const orgId = resolved.orgId;

    const contentType = c.req.header("Content-Type") ?? "";
    let text = "";
    const options: Record<string, string> = Object.fromEntries(
      Object.entries(c.req.query()).map(([k, v]) => [k, String(v)]),
    );

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody().catch(() => null);
      if (!form) return c.json({ error: "Could not read the multipart body." }, 400);
      const file = form["file"];
      if (!(file instanceof File)) {
        return c.json({ error: "Expected a `file` part containing the CSV." }, 400);
      }
      if (file.size > MAX_CSV_BYTES) {
        return c.json({ error: `File is larger than the ${MAX_CSV_BYTES / (1024 * 1024)}MB limit.` }, 413);
      }
      text = await file.text();
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === "string") options[k] = v;
      }
    } else {
      text = await c.req.text().catch(() => "");
      if (text.length > MAX_CSV_BYTES) {
        return c.json({ error: `Body is larger than the ${MAX_CSV_BYTES / (1024 * 1024)}MB limit.` }, 413);
      }
    }

    if (!text.trim()) {
      return c.json({ error: "The CSV was empty." }, 400);
    }

    // Only an explicit opt-out writes. Anything else — absent, malformed,
    // "false-ish" — previews, because the safe branch must be the default one.
    const dryRun = String(options.dryRun ?? "true").toLowerCase() !== "false";
    const resolvedSource: LeadSource =
      typeof options.source === "string" && (INGEST_SOURCES as string[]).includes(options.source)
        ? (options.source as LeadSource)
        : "crm";

    const org = await getOrg(orgId);
    const schema = await resolveIntakeSchema(orgId, org?.vertical);
    const plan = planCsvImport({
      text,
      schema,
      defaultCountryCode: typeof options.defaultCountryCode === "string" ? options.defaultCountryCode : undefined,
    });
    const preview = summarizePlan(plan);

    if (plan.errors.length) {
      return c.json({ ok: false, dryRun: true, applied: false, preview }, 400);
    }

    if (dryRun) {
      return c.json({
        ok: true,
        dryRun: true,
        applied: false,
        preview,
        note: "Nothing was written. Re-send with dryRun=false to import the rows above.",
      });
    }

    let created = 0;
    let updated = 0;
    const failedRows: number[] = [];
    for (const row of plan.rows) {
      try {
        const result = await upsertLead({
          orgId,
          phone: row.phone,
          name: row.name,
          fields: row.fields,
          source: resolvedSource,
        });
        if (result.created) created++;
        else updated++;
      } catch {
        // One bad row must not abandon the rest of the file half-imported with
        // no record of where it stopped. Row numbers are reported so the
        // operator can re-send just those.
        failedRows.push(row.row);
      }
    }

    return c.json({
      ok: failedRows.length === 0,
      dryRun: false,
      applied: true,
      created,
      updated,
      failedRows: failedRows.length ? failedRows : undefined,
      preview,
    });
  });
