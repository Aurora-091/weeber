/**
 * Public, unauthenticated endpoints for the landing page — no admin key, no
 * Supabase session. Deliberately its own small router (not tucked into
 * voice/routes.ts or the user-authed app router) so "what needs zero
 * auth" stays obvious from the file, not buried in a middleware chain.
 */
import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db } from "../database";
import { platformSettings } from "../database/schema";
import { joinWaitlist, addWaitlistPhone, getWaitlistDisplayCount, unsubscribeByToken } from "./waitlist";
import { broadcastWaitlistCount } from "./waitlist-ws";
import { submitSupportTicket } from "./support";
import { sendTransactionalEmail } from "./email";
import { enterpriseInquiryReceiptHtml, supportTicketReceiptHtml } from "./email-templates";
import { getOrg } from "../voice/org-queries";
import { resolveIntakeSchema } from "../voice/leads/schema-store";
import { validateFields } from "../voice/leads/intake-schema";
import { upsertLead } from "../voice/leads/leads";
import { normalizePhone } from "../voice/leads/csv-import";
import { makeFixedWindowLimiter } from "../voice/fixed-window-limiter";

// Per-(ip+org) submit limiter for the hosted intake form — a public,
// unauthenticated surface, so it needs its own abuse gate independent of the
// key-authed ingest path. Process-local, same tradeoff as the other limiters.
const hostedFormLimiter = makeFixedWindowLimiter(60_000, 10);

// Per-IP limiter for the client-error beacon below — unauthenticated, so it
// needs its own abuse gate; generous enough that a real retry storm during
// genuine connectivity trouble isn't shed, tight enough that it can't be used
// to spam Railway's logs.
const clientErrorLimiter = makeFixedWindowLimiter(60_000, 30);

const CLIENT_ERROR_KIND_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_CLIENT_ERROR_MESSAGE_LEN = 500;
const MAX_CLIENT_ERROR_PATH_LEN = 256;

function unsubscribePageHtml(message: string, isError = false): string {
  const color = isError ? "#dc2626" : "#0a0a0a";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Waitlist — Weeber</title></head>
<body style="margin:0;padding:64px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fafaf8;text-align:center;color:${color};">
  <div style="max-width:420px;margin:0 auto;">
    <h1 style="font-size:20px;font-weight:600;margin:0 0 12px;">${message}</h1>
    ${!isError ? '<p style="font-size:14px;color:#6b7280;margin:0;">You won\'t receive any further waitlist emails. If this was a mistake, email us at <a href="mailto:hello@weeber.ai">hello@weeber.ai</a>.</p>' : ""}
  </div>
</body></html>`;
}

export const publicRoutes = new Hono()
  .post("/waitlist", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { email, name, phone, referralCode, source } = body as {
      email?: string;
      name?: string;
      phone?: string;
      referralCode?: string;
      source?: string;
    };
    if (!email?.trim()) return c.json({ error: "`email` is required" }, 400);

    const result = await joinWaitlist({ email, name, phone, referralCode, source });
    if (!result.ok) return c.json({ error: result.error }, 400);

    if (result.alreadyJoined) {
      return c.json({ joined: true, alreadyJoined: true, ownReferralCode: result.ownReferralCode }, 200);
    }

    void broadcastWaitlistCount();
    return c.json(
      {
        joined: true,
        alreadyJoined: false,
        ownReferralCode: result.ownReferralCode,
        position: result.position,
        displayCount: result.displayCount,
      },
      201,
    );
  })

  // Optional post-signup follow-up — the success screen offers "add your
  // phone" as a separate step, not part of the initial signup form.
  .post("/waitlist/phone", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { email, phone } = body as { email?: string; phone?: string };
    if (!email?.trim() || !phone?.trim()) return c.json({ error: "`email` and `phone` are required" }, 400);
    const saved = await addWaitlistPhone(email, phone);
    if (!saved) return c.json({ error: "Could not save phone number" }, 400);
    return c.json({ saved: true }, 200);
  })

  // Non-WS fallback for the initial count (e.g. before the socket connects,
  // or if it can't connect at all) — the WS hook uses this as its first
  // paint, then switches to live pushes.
  .get("/waitlist/count", async (c) => {
    const count = await getWaitlistDisplayCount();
    return c.json({ count }, 200);
  })

  // Plain HTML, not a JSON API response — this is meant to be opened
  // directly from an email link, no frontend route needed.
  .get("/waitlist/unsubscribe", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.html(unsubscribePageHtml("Invalid unsubscribe link.", true), 400);

    const result = await unsubscribeByToken(token);
    if (result === "invalid_token") return c.html(unsubscribePageHtml("Invalid or expired unsubscribe link.", true), 400);
    return c.html(unsubscribePageHtml("You've been unsubscribed."), 200);
  })

  .post("/support", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { email, subject, message } = body as { email?: string; subject?: string; message?: string };
    if (!email?.trim() || !subject?.trim() || !message?.trim()) {
      return c.json({ error: "`email`, `subject`, and `message` are required" }, 400);
    }
    const ticket = await submitSupportTicket({ email, subject, message });
    if (!ticket) return c.json({ error: "Failed to submit ticket" }, 500);
    void sendTransactionalEmail({
      to: email,
      subject: "We got your message",
      html: supportTicketReceiptHtml({ email, subject }),
      tags: [{ name: "category", value: "support-receipt" }],
    });
    return c.json({ submitted: true }, 201);
  })

  // Enterprise-inquiry form (landing page's EnterpriseDialog) — routed through
  // the same support-ticket table rather than a dedicated one; it's a single
  // multi-step lead-capture form, not a recurring surface that needs its own
  // schema. Subject is a fixed tag so these are easy to filter for in the
  // admin support-tickets view.
  .post("/enterprise-inquiry", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { name, email, businessType, callVolume, painPoint, timeline, extraInfo } = body as {
      name?: string;
      email?: string;
      businessType?: string;
      callVolume?: string;
      painPoint?: string;
      timeline?: string;
      extraInfo?: string;
    };
    if (!name?.trim() || !email?.trim() || !businessType?.trim()) {
      return c.json({ error: "`name`, `email`, and `businessType` are required" }, 400);
    }
    const message = [
      `Name: ${name.trim()}`,
      `Business type: ${businessType.trim()}`,
      `Call volume: ${callVolume?.trim() || "(not provided)"}`,
      `Pain point: ${painPoint?.trim() || "(not provided)"}`,
      `Timeline: ${timeline?.trim() || "(not provided)"}`,
      `Extra info: ${extraInfo?.trim() || "(none)"}`,
    ].join("\n");
    const ticket = await submitSupportTicket({ email, subject: "Enterprise inquiry", message });
    if (!ticket) return c.json({ error: "Failed to submit inquiry" }, 500);
    void sendTransactionalEmail({
      to: email,
      subject: "Thanks for reaching out to Weeber",
      html: enterpriseInquiryReceiptHtml({ name: name.trim() }),
      tags: [{ name: "category", value: "enterprise-inquiry-receipt" }],
    });
    return c.json({ submitted: true }, 201);
  })

  // ── Hosted intake form (Phase 3, native leads layer §10) ──────────────────
  // A public, embeddable form an org can share so anyone can submit a lead
  // without a login. The org's UUID (`orgId`) is the public form token — it's
  // non-secret (already exposed in the app), grants ONLY "submit a lead to this
  // org", and needs no migration. A thin client of the same ingest core:
  // resolve the org's schema, validate (regulated fields dropped), upsert by
  // (orgId, phone). No API key — abuse is bounded by a honeypot + rate limit.

  // Public schema for rendering the form. Returns only field definitions +
  // a display name — nothing org-sensitive.
  .get("/leads/:orgId/form", async (c) => {
    const orgId = c.req.param("orgId");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "Form not found." }, 404);
    const fields = await resolveIntakeSchema(orgId, org.vertical);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ orgName: org.name ?? null, fields }, 200);
  })

  // Public submit. Honeypot (`_website` must stay empty — bots fill it) +
  // per-(ip,org) rate limit. Never reveals whether the honeypot tripped; a bot
  // gets the same 200 as a human so it can't probe the gate.
  .post("/leads/:orgId/form", async (c) => {
    const orgId = c.req.param("orgId");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "Form not found." }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Expected a JSON object body." }, 400);
    const { phone, name, fields, _website } = body as {
      phone?: unknown;
      name?: unknown;
      fields?: unknown;
      _website?: unknown;
    };

    // Honeypot: a real user never sees or fills `_website`. Silently accept and
    // drop so a bot can't distinguish this from a real submission.
    if (typeof _website === "string" && _website.trim() !== "") {
      return c.json({ ok: true, submitted: true }, 201);
    }

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    if (hostedFormLimiter(`${ip}:${orgId}`)) {
      return c.json({ error: "Too many submissions. Please try again in a minute." }, 429);
    }

    if (typeof phone !== "string" || !phone.trim()) {
      return c.json({ error: "`phone` is required." }, 400);
    }

    const schema = await resolveIntakeSchema(orgId, org.vertical);
    const { accepted } = validateFields(fields as Record<string, unknown> | null | undefined, schema);

    // Bug fix (2026-08-15, pilot latency audit F1): a public form is the
    // likeliest place to get a bare national number ("4155551234", no country
    // code) — normalize it the same way the CSV bulk-import path already
    // does, using the org's configured country as the default, or the lead is
    // stored in a shape `getLeadGreetingContext` can never match against the
    // provider's E.164 caller ID at call time (see leads.ts::createLeadManual
    // for the full explanation).
    const normalizedPhone = normalizePhone(phone.trim(), org.countryCode ?? undefined);
    if (!normalizedPhone) {
      return c.json({ error: "Could not parse that phone number. Please include a country code, e.g. +1 415 555 1234." }, 400);
    }

    const { id, created } = await upsertLead({
      orgId,
      phone: normalizedPhone,
      name: typeof name === "string" ? name : null,
      fields: accepted,
      source: "form",
    });
    return c.json({ ok: true, submitted: true, leadId: id, created }, created ? 201 : 200);
  })

  // Client-side auth/network failure beacon (2026-08-24). Login's Supabase
  // calls go straight from the browser to Supabase, never through this API —
  // so a network failure during sign-in previously left zero trace anywhere
  // we could see it ("nothing on Railway" was structurally true, not a
  // logging gap). Best-effort and console-logged (grep `[client-error]` in
  // Railway logs); never fails the caller and never blocks the login flow
  // it's reporting on. No DB write — this is a debugging aid, not a metric
  // that needs querying yet.
  .post("/client-error", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    if (clientErrorLimiter(ip)) return c.body(null, 429);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.body(null, 202);
    const { kind, message, path, attempt, exhausted, connection } = body as Record<string, unknown>;

    console.warn("[client-error]", {
      kind: typeof kind === "string" && CLIENT_ERROR_KIND_RE.test(kind) ? kind : "unknown",
      message: typeof message === "string" ? message.slice(0, MAX_CLIENT_ERROR_MESSAGE_LEN) : null,
      path: typeof path === "string" ? path.slice(0, MAX_CLIENT_ERROR_PATH_LEN) : null,
      attempt: typeof attempt === "number" ? attempt : null,
      exhausted: Boolean(exhausted),
      connection: typeof connection === "string" ? connection.slice(0, 32) : null,
      ip,
      userAgent: c.req.header("user-agent")?.slice(0, 200) ?? null,
    });

    return c.body(null, 202);
  })

  .get("/tracking-config", async (c) => {
    const rows = await db
      .select()
      .from(platformSettings)
      .where(inArray(platformSettings.key, ["gtm_container_id", "ga4_measurement_id"]));
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    c.header("Cache-Control", "public, max-age=300, s-maxage=300");
    return c.json({
      gtmContainerId: map.gtm_container_id || null,
      ga4MeasurementId: map.ga4_measurement_id || null,
    }, 200);
  });
