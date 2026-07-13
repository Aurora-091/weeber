/**
 * Public, unauthenticated endpoints for the landing page — no admin key, no
 * Supabase session. Deliberately its own small router (not tucked into
 * voice/routes.ts or the merchant-authed app router) so "what needs zero
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
