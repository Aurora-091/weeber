/**
 * Pre-launch/marketing waitlist — the landing page's one real conversion
 * action (see schema.ts's `waitlistSignups`). Deliberately minimal: email +
 * optional name/referral/source, no verification flow yet.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import { waitlistSignups } from "../database/schema";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type JoinWaitlistResult = { ok: true; alreadyJoined: boolean } | { ok: false; error: string };

/** Idempotent — re-submitting the same email is a no-op, not an error, so a
 * merchant double-clicking "Join" doesn't see a confusing failure. */
export async function joinWaitlist(input: {
  email: string;
  name?: string;
  referralCode?: string;
  source?: string;
}): Promise<JoinWaitlistResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Invalid email address" };

  const [existing] = await db.select({ id: waitlistSignups.id }).from(waitlistSignups).where(eq(waitlistSignups.email, email)).limit(1);
  if (existing) return { ok: true, alreadyJoined: true };

  await db.insert(waitlistSignups).values({
    email,
    name: input.name?.trim() || null,
    referralCode: input.referralCode?.trim() || null,
    source: input.source?.trim() || null,
  });
  return { ok: true, alreadyJoined: false };
}

export async function listWaitlist(limit = 500) {
  const bounded = Math.min(Math.max(limit, 1), 2000);
  return db.select().from(waitlistSignups).orderBy(desc(waitlistSignups.createdAt)).limit(bounded);
}

/** Real signal for Marketing Analytics — signups grouped by day, and by
 * referral/source — no fabricated traffic/funnel numbers, only what this
 * table actually records. */
export async function waitlistMarketingSummary(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(waitlistSignups);
  const inRange = rows.filter((r) => r.createdAt >= since);

  const byDay: Record<string, number> = {};
  for (const row of inRange) {
    const day = row.createdAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  const bySource: Record<string, number> = {};
  for (const row of inRange) {
    const key = row.source ?? "(direct)";
    bySource[key] = (bySource[key] ?? 0) + 1;
  }

  return {
    rangeDays: days,
    totalSignups: rows.length,
    signupsInRange: inRange.length,
    converted: rows.filter((r) => r.convertedOrgId).length,
    signupsByDay: byDay,
    signupsBySource: bySource,
  };
}
