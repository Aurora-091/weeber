/**
 * Inactivity lifecycle sweep (2026-07-20) — stops cold orgs from silently
 * bleeding Twilio billing (each rented number rents monthly whether or not
 * the org ever calls). Two-stage, both driven off orgs.lastActivityAt:
 *
 *   >= ORG_INACTIVITY_SUSPEND_DAYS (default 30) idle, status "active"
 *     -> closeOrgTelephony(orgId, "suspend"): release numbers + suspend
 *        subaccount (reversible), status -> "suspended", email the owner.
 *
 *   >= ORG_INACTIVITY_CLOSE_DAYS (default 60) idle, status "suspended"
 *     -> closeOrgTelephony(orgId, "close"): permanently close the
 *        subaccount, status -> "closed", email the owner.
 *
 * Deliberately gated so it's a slow, reversible ramp with an email at each
 * step — an org only gets permanently closed after it's already been
 * suspended (numbers released) for the gap between the two thresholds and
 * STILL showed no activity. Any activity (call or /me bootstrap) bumps
 * lastActivityAt, taking the org back out of the sweep's reach; a suspended
 * org that logs back in is reactivated by the login path, not here.
 */
import { and, eq, lte } from "drizzle-orm";
// ADR-116 addendum: a timer-driven sweep, never on a live call's turn path —
// uses the background connection pool so it can't compete with call-latency writes.
import { dbBackground as db } from "../../database";
import { orgs } from "../../database/schema";
import { closeOrgTelephony } from "../twilio-provisioning";
import { sendOrgLifecycleEmail } from "../../app/org-lifecycle-email";

const SUSPEND_DAYS = Number(process.env.ORG_INACTIVITY_SUSPEND_DAYS ?? 30);
const CLOSE_DAYS = Number(process.env.ORG_INACTIVITY_CLOSE_DAYS ?? 60);

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

export type LifecycleSweepResult = { suspended: number; closed: number };

export async function runOrgLifecycleSweep(): Promise<LifecycleSweepResult> {
  let suspended = 0;
  let closed = 0;

  // Stage 1: active + idle >= SUSPEND_DAYS -> suspend.
  const toSuspend = await db
    .select({ id: orgs.id, name: orgs.name, contactEmail: orgs.contactEmail })
    .from(orgs)
    .where(and(eq(orgs.status, "active"), lte(orgs.lastActivityAt, cutoff(SUSPEND_DAYS))));

  for (const org of toSuspend) {
    const res = await closeOrgTelephony(org.id, "suspend");
    if (res.ok) {
      suspended++;
      await sendOrgLifecycleEmail(org.contactEmail, org.name, "suspended", { releasedNumbers: res.releasedNumbers }).catch(
        (err) => console.error(`[lifecycle-sweep] suspend email failed for ${org.id}`, err),
      );
    } else {
      console.error(`[lifecycle-sweep] suspend failed for ${org.id}: ${res.error}`);
    }
  }

  // Stage 2: already suspended + idle >= CLOSE_DAYS -> permanent close.
  const toClose = await db
    .select({ id: orgs.id, name: orgs.name, contactEmail: orgs.contactEmail })
    .from(orgs)
    .where(and(eq(orgs.status, "suspended"), lte(orgs.lastActivityAt, cutoff(CLOSE_DAYS))));

  for (const org of toClose) {
    const res = await closeOrgTelephony(org.id, "close");
    if (res.ok) {
      closed++;
      await sendOrgLifecycleEmail(org.contactEmail, org.name, "closed", {}).catch((err) =>
        console.error(`[lifecycle-sweep] close email failed for ${org.id}`, err),
      );
    } else {
      console.error(`[lifecycle-sweep] close failed for ${org.id}: ${res.error}`);
    }
  }

  if (suspended || closed) {
    console.log(`[lifecycle-sweep] suspended=${suspended} closed=${closed}`);
  }
  return { suspended, closed };
}
