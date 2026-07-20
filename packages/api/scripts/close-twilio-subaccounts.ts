/**
 * One-off + reusable cleanup: close leftover Twilio SUB-accounts under the
 * platform parent account.
 *
 * Billing context: an idle sub-account itself costs nothing — what bills is
 * each RENTED PHONE NUMBER (monthly) plus usage. So closing a sub-account
 * releases its numbers (Twilio auto-releases every number on close) and
 * stops the bleed. `closed` is PERMANENT and irreversible; `suspended` is a
 * reversible pause (but numbers keep billing while suspended, so we release
 * them explicitly first in the suspend path).
 *
 * Usage (run from repo root so it picks up the root .env):
 *   bun --env-file=.env packages/api/scripts/close-twilio-subaccounts.ts            # DRY RUN — lists only
 *   bun --env-file=.env packages/api/scripts/close-twilio-subaccounts.ts --confirm  # actually closes
 *   bun --env-file=.env packages/api/scripts/close-twilio-subaccounts.ts --confirm --suspend  # suspend instead of close
 *
 * Requires PARENT creds: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.
 */
import Twilio from "twilio";

const parentSid = process.env.TWILIO_ACCOUNT_SID;
const parentToken = process.env.TWILIO_AUTH_TOKEN;

if (!parentSid || !parentToken) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (parent account creds).");
  process.exit(1);
}
if (!parentSid.startsWith("AC")) {
  console.error(`TWILIO_ACCOUNT_SID must start with "AC" (got "${parentSid.slice(0, 4)}...").`);
  process.exit(1);
}

const confirm = process.argv.includes("--confirm");
const suspendMode = process.argv.includes("--suspend");
const targetStatus: "closed" | "suspended" = suspendMode ? "suspended" : "closed";

const client = Twilio(parentSid, parentToken);

async function main() {
  // Pull both active and suspended sub-accounts — anything not already closed
  // is a candidate. (Closed ones are terminal, nothing to do.)
  const [active, suspended] = await Promise.all([
    client.api.v2010.accounts.list({ status: "active", limit: 200 }),
    client.api.v2010.accounts.list({ status: "suspended", limit: 200 }),
  ]);

  // The parent account itself shows up in the list — never touch it.
  const subs = [...active, ...suspended].filter((a) => a.sid !== parentSid);

  if (subs.length === 0) {
    console.log("No open sub-accounts found. Nothing to do.");
    return;
  }

  console.log(`Found ${subs.length} sub-account(s) under parent ${parentSid}:\n`);

  for (const sub of subs) {
    // Count rented numbers per sub — this is the actual billing driver.
    let numberCount = "?";
    try {
      const nums = await Twilio(sub.sid, sub.authToken).incomingPhoneNumbers.list({ limit: 100 });
      numberCount = String(nums.length);
    } catch {
      numberCount = "unreadable";
    }
    console.log(`  ${sub.sid}  [${sub.status}]  numbers=${numberCount}  "${sub.friendlyName}"`);
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --confirm to set these to "${targetStatus}".`);
    console.log(`(Closing is PERMANENT and releases all numbers. Use --suspend for a reversible pause.)`);
    return;
  }

  console.log(`\n--confirm set → setting ${subs.length} sub-account(s) to "${targetStatus}"...\n`);
  let done = 0;
  for (const sub of subs) {
    try {
      // In suspend mode, release numbers first so they stop billing (suspend
      // alone does NOT release them). Close mode releases them automatically.
      if (suspendMode) {
        const subClient = Twilio(sub.sid, sub.authToken);
        const nums = await subClient.incomingPhoneNumbers.list({ limit: 100 });
        for (const n of nums) await subClient.incomingPhoneNumbers(n.sid).remove();
      }
      await client.api.v2010.accounts(sub.sid).update({ status: targetStatus });
      done++;
      console.log(`  ✓ ${sub.sid} → ${targetStatus}  "${sub.friendlyName}"`);
    } catch (err) {
      console.error(`  ✗ ${sub.sid} FAILED: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone. ${done}/${subs.length} updated.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
