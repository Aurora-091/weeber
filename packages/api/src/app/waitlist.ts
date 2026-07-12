/**
 * Pre-launch/marketing waitlist — the landing page's main conversion action
 * (see schema.ts's `waitlistSignups`). Referral system (codes, counts,
 * position, unsubscribe) ported from Vocalist's waitlist — see DECISIONS.md
 * ADR-041 for the full port notes and what was deliberately simplified.
 */
import { count as countRows, desc, eq, lte, ne, sql } from "drizzle-orm";
import { db } from "../database";
import { waitlistSignups } from "../database/schema";
import { sendTransactionalEmail } from "./email";
import { waitlistConfirmationHtml, referralNotificationHtml } from "./email-templates";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

/** Vanity display offset (matches the "first 100 customers" framing on the
 * landing page) — not a real prior-signup count, just makes an early
 * waitlist look less like "signup #1", same choice Vocalist made. */
export const WAITLIST_DISPLAY_OFFSET = 40;

function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/** Short, shareable, human-typeable — e.g. "weeber-a1b2c3d". */
function generateReferralCode(): string {
  return `weeber-${randomBase36(7)}`;
}

/** Deliberately not derived from the referral code — an unsubscribe link
 * shouldn't double as a guessable referral code and vice versa. */
function generateUnsubscribeToken(): string {
  return randomBase36(24);
}

export type JoinWaitlistResult =
  | { ok: true; alreadyJoined: true; ownReferralCode: string | null }
  | { ok: true; alreadyJoined: false; ownReferralCode: string; position: number; displayCount: number }
  | { ok: false; error: string };

/** Idempotent — re-submitting the same email is a no-op, not an error, so a
 * user double-clicking "Join" doesn't see a confusing failure. */
export async function joinWaitlist(input: {
  email: string;
  name?: string;
  phone?: string;
  referralCode?: string;
  source?: string;
}): Promise<JoinWaitlistResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Invalid email address" };
  if (input.phone && !PHONE_RE.test(input.phone)) return { ok: false, error: "Invalid phone number" };

  const [existing] = await db
    .select({ id: waitlistSignups.id, ownReferralCode: waitlistSignups.ownReferralCode })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.email, email))
    .limit(1);
  if (existing) return { ok: true, alreadyJoined: true, ownReferralCode: existing.ownReferralCode };

  // Referrer lookup — a signup can arrive with a referral code that doesn't
  // match anything (typo'd/stale link); that's not an error, it just doesn't
  // get attributed.
  let referrer: { id: number } | undefined;
  const referredByCode = input.referralCode?.trim();
  if (referredByCode) {
    [referrer] = await db
      .select({ id: waitlistSignups.id })
      .from(waitlistSignups)
      .where(eq(waitlistSignups.ownReferralCode, referredByCode))
      .limit(1);
  }

  const ownReferralCode = generateReferralCode();
  const unsubscribeToken = generateUnsubscribeToken();

  const [inserted] = await db
    .insert(waitlistSignups)
    .values({
      email,
      name: input.name?.trim() || null,
      phone: input.phone?.trim() || null,
      referralCode: referrer ? referredByCode : null,
      source: input.source?.trim() || null,
      ownReferralCode,
      unsubscribeToken,
    })
    .returning({ id: waitlistSignups.id, createdAt: waitlistSignups.createdAt });

  if (referrer) {
    // Atomic increment (SQL expression, not read-then-write) — concurrent
    // referrals from the same code must not lose an increment to a race.
    await db
      .update(waitlistSignups)
      .set({ referralCount: sql`${waitlistSignups.referralCount} + 1` })
      .where(eq(waitlistSignups.id, referrer.id));
  }

  const [{ value: position }] = await db
    .select({ value: countRows() })
    .from(waitlistSignups)
    .where(lte(waitlistSignups.createdAt, inserted!.createdAt));

  // --- Fire transactional emails (non-blocking) ---
  // Referral links must land on the marketing site (landing.tsx consumes
  // `?ref=`); unsubscribe links hit an /api route, so they stay on the API's
  // own origin (PUBLIC_APP_URL is the backend's public URL — Twilio webhook
  // construction depends on that meaning, so it can't double as a web origin).
  const webUrl = process.env.PUBLIC_WEB_URL || "https://www.weeber.ai";
  const apiOrigin = process.env.PUBLIC_APP_URL || webUrl;
  const referralLink = `${webUrl}?ref=${ownReferralCode}`;
  const unsubscribeLink = `${apiOrigin}/api/public/waitlist/unsubscribe?token=${unsubscribeToken}`;

  void sendTransactionalEmail({
    to: email,
    subject: "You're in — welcome to Weeber",
    html: waitlistConfirmationHtml({ name: input.name?.trim() || null, referralLink, unsubscribeLink }),
    tags: [{ name: "category", value: "waitlist-confirmation" }],
  });

  // Notify the referrer that someone joined via their link
  if (referrer) {
    void (async () => {
      const [referrerRow] = await db
        .select({ email: waitlistSignups.email, name: waitlistSignups.name, ownReferralCode: waitlistSignups.ownReferralCode, unsubscribeToken: waitlistSignups.unsubscribeToken })
        .from(waitlistSignups)
        .where(eq(waitlistSignups.id, referrer!.id))
        .limit(1);
      if (referrerRow?.email && referrerRow.unsubscribeToken) {
        const refLink = `${webUrl}?ref=${referrerRow.ownReferralCode}`;
        const refUnsub = `${apiOrigin}/api/public/waitlist/unsubscribe?token=${referrerRow.unsubscribeToken}`;
        void sendTransactionalEmail({
          to: referrerRow.email,
          subject: "Someone joined Weeber using your link!",
          html: referralNotificationHtml({ name: referrerRow.name, referralLink: refLink, unsubscribeLink: refUnsub }),
          tags: [{ name: "category", value: "waitlist-referral" }],
        });
      }
    })();
  }

  return {
    ok: true,
    alreadyJoined: false,
    ownReferralCode,
    position,
    displayCount: WAITLIST_DISPLAY_OFFSET + position,
  };
}

/** Best-effort — called after signup shows the "add your phone" prompt. Not
 * validated as strictly as signup itself since it's an optional follow-up,
 * a bad number here just means no SMS, not a broken record. */
export async function addWaitlistPhone(email: string, phone: string): Promise<boolean> {
  const cleanEmail = email.trim().toLowerCase();
  if (!PHONE_RE.test(phone)) return false;
  const updated = await db
    .update(waitlistSignups)
    .set({ phone: phone.trim() })
    .where(eq(waitlistSignups.email, cleanEmail))
    .returning({ id: waitlistSignups.id });
  return updated.length > 0;
}

/** Real, non-guessable total for the WS live-count broadcast and the
 * post-signup "you're #N" number — excludes unsubscribed rows, matching
 * what a user would actually consider "on the list". */
export async function getWaitlistDisplayCount(): Promise<number> {
  const [{ value }] = await db.select({ value: countRows() }).from(waitlistSignups).where(ne(waitlistSignups.unsubscribed, true));
  return WAITLIST_DISPLAY_OFFSET + value;
}

export type UnsubscribeResult = "unsubscribed" | "invalid_token" | "already_unsubscribed";

export async function unsubscribeByToken(token: string): Promise<UnsubscribeResult> {
  const [row] = await db.select({ id: waitlistSignups.id, unsubscribed: waitlistSignups.unsubscribed }).from(waitlistSignups).where(eq(waitlistSignups.unsubscribeToken, token)).limit(1);
  if (!row) return "invalid_token";
  if (row.unsubscribed) return "already_unsubscribed";
  await db.update(waitlistSignups).set({ unsubscribed: true }).where(eq(waitlistSignups.id, row.id));
  return "unsubscribed";
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
    referredSignups: rows.filter((r) => r.referralCode).length,
    signupsByDay: byDay,
    signupsBySource: bySource,
  };
}
