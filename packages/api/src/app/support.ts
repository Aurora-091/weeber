/**
 * Merchant support tickets (see schema.ts's `supportTickets`). Submittable
 * from `/app` (authenticated, `orgId` known) or the public landing page
 * (email-only, no account required — `orgId` stays null).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import { supportTickets } from "../database/schema";

export async function submitSupportTicket(input: { orgId?: string | null; email: string; subject: string; message: string }) {
  if (!input.email.trim() || !input.subject.trim() || !input.message.trim()) {
    return null;
  }
  const [row] = await db
    .insert(supportTickets)
    .values({
      orgId: input.orgId ?? null,
      email: input.email.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
    })
    .returning();
  return row;
}

export async function listSupportTickets(status?: string, limit = 200) {
  const bounded = Math.min(Math.max(limit, 1), 1000);
  const base = db.select().from(supportTickets).orderBy(desc(supportTickets.createdAt)).limit(bounded);
  return status ? base.where(eq(supportTickets.status, status)) : base;
}

export async function updateSupportTicketStatus(id: number, status: string) {
  const [row] = await db
    .update(supportTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportTickets.id, id))
    .returning();
  return row;
}
