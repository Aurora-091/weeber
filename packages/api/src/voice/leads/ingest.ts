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

const INGEST_SOURCES: LeadSource[] = ["form", "webhook", "pipedream", "crm", "manual"];

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

    const { id, created } = await upsertLead({
      orgId,
      phone: phone.trim(),
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
  });
