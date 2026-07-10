/**
 * Admin-authored broadcasts to merchants or the whole waitlist (see
 * schema.ts's `broadcasts`). Deliberately honest about what actually
 * happened: `status` only becomes "sent" if an email actually went out
 * through a configured provider; with no `RESEND_API_KEY` set, sending
 * marks the row "queued" (not a fabricated "sent") so nobody mistakes an
 * unconfigured environment for a working one.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import { broadcasts, orgMembers, waitlistSignups } from "../database/schema";
import { resilientCall } from "../voice/integrations/resilient-fetch";

export async function createBroadcast(input: { title: string; body: string; audience: string; createdBy: string }) {
  const [row] = await db
    .insert(broadcasts)
    .values({
      title: input.title.trim(),
      body: input.body,
      audience: input.audience.trim() || "all",
      status: "draft",
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function listBroadcasts(limit = 100) {
  const bounded = Math.min(Math.max(limit, 1), 500);
  return db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).limit(bounded);
}

async function resolveAudienceEmails(audience: string): Promise<string[]> {
  if (audience === "waitlist") {
    const rows = await db.select({ email: waitlistSignups.email }).from(waitlistSignups);
    return rows.map((r) => r.email);
  }
  if (audience === "all") {
    const rows = await db.select({ email: orgMembers.email }).from(orgMembers);
    return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
  }
  // Specific orgId
  const rows = await db.select({ email: orgMembers.email }).from(orgMembers).where(eq(orgMembers.orgId, audience));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

/**
 * Attempts to actually send via Resend if configured; otherwise marks the
 * broadcast "queued" — real state, not a fabricated success. Returns the
 * updated row either way.
 */
export async function sendBroadcast(id: number) {
  const [broadcast] = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
  if (!broadcast) return null;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const [updated] = await db
      .update(broadcasts)
      .set({ status: "queued" })
      .where(eq(broadcasts.id, id))
      .returning();
    return updated;
  }

  const recipients = await resolveAudienceEmails(broadcast.audience);
  if (recipients.length === 0) {
    const [updated] = await db.update(broadcasts).set({ status: "queued" }).where(eq(broadcasts.id, id)).returning();
    return updated;
  }

  const result = await resilientCall(
    async (signal) => {
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(
          recipients.map((to) => ({
            from: process.env.BROADCAST_FROM_EMAIL || "weeber@weeber.ai",
            to,
            subject: broadcast.title,
            html: broadcast.body,
          })),
        ),
      });
      if (!res.ok) throw new Error(`Resend API returned ${res.status}`);
      return res.json();
    },
    { integration: "resend-broadcast", timeoutMs: 10_000 },
  );

  const [updated] = await db
    .update(broadcasts)
    .set({ status: result.ok ? "sent" : "failed", sentAt: result.ok ? new Date() : undefined })
    .where(eq(broadcasts.id, id))
    .returning();
  return updated;
}
