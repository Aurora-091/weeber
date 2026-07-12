/**
 * User support tickets (see schema.ts's `supportTickets`). Submittable
 * from `/app` (authenticated, `orgId` known) or the public landing page
 * (email-only, no account required — `orgId` stays null).
 */
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../database";
import { supportTickets, supportReplies } from "../database/schema";
import { sendTransactionalEmail } from "./email";
import { supportReplyHtml } from "./email-templates";

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

export async function listSupportReplies(ticketId: number) {
  return db.select().from(supportReplies).where(eq(supportReplies.ticketId, ticketId)).orderBy(asc(supportReplies.createdAt));
}

/**
 * Actually sends the reply as an email to the ticket's submitter via Resend
 * (see email.ts) — not just a UI action that records text nobody receives.
 * Records the reply row regardless of send outcome (so the thread stays
 * accurate even if Resend is unconfigured/down), but `emailSent` reflects
 * what really happened — same "never fabricate success" discipline as
 * broadcasts.ts and waitlist confirmation emails.
 */
export async function replySupportTicket(input: { ticketId: number; message: string; sentBy: string }) {
  const message = input.message.trim();
  if (!message) return null;

  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, input.ticketId)).limit(1);
  if (!ticket) return null;

  const emailSent = await sendTransactionalEmail({
    to: ticket.email,
    subject: `Re: ${ticket.subject}`,
    html: supportReplyHtml({ subject: ticket.subject, originalMessage: ticket.message, reply: message }),
  });

  const [reply] = await db
    .insert(supportReplies)
    .values({ ticketId: input.ticketId, message, sentBy: input.sentBy, emailSent })
    .returning();

  return reply;
}
