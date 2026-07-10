/**
 * Public, unauthenticated endpoints for the landing page — no admin key, no
 * Supabase session. Deliberately its own small router (not tucked into
 * voice/routes.ts or the merchant-authed app router) so "what needs zero
 * auth" stays obvious from the file, not buried in a middleware chain.
 */
import { Hono } from "hono";
import { joinWaitlist } from "./waitlist";
import { submitSupportTicket } from "./support";

export const publicRoutes = new Hono()
  .post("/waitlist", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { email, name, referralCode, source } = body as {
      email?: string;
      name?: string;
      referralCode?: string;
      source?: string;
    };
    if (!email?.trim()) return c.json({ error: "`email` is required" }, 400);

    const result = await joinWaitlist({ email, name, referralCode, source });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ joined: true, alreadyJoined: result.alreadyJoined }, result.alreadyJoined ? 200 : 201);
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
    return c.json({ submitted: true }, 201);
  });
