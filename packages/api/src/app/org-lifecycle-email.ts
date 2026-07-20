/**
 * Owner-facing emails for the inactivity lifecycle (2026-07-20). Sent by
 * voice/workflows/org-lifecycle-sweep.ts when an org is auto-suspended or
 * auto-closed for inactivity. Thin wrapper over sendTransactionalEmail;
 * no-ops gracefully (returns false) when there's no contact email or when
 * Resend isn't configured.
 */
import { sendTransactionalEmail } from "./email";

type LifecycleStage = "suspended" | "closed";

export async function sendOrgLifecycleEmail(
  to: string | null,
  orgName: string | null,
  stage: LifecycleStage,
  meta: { releasedNumbers?: number },
): Promise<boolean> {
  if (!to) return false;
  const workspace = orgName?.trim() || "your workspace";

  if (stage === "suspended") {
    const numLine =
      meta.releasedNumbers && meta.releasedNumbers > 0
        ? `We've released ${meta.releasedNumbers} phone number${meta.releasedNumbers === 1 ? "" : "s"} attached to it so you're not billed for numbers you're not using.`
        : "";
    return sendTransactionalEmail({
      to,
      subject: `${workspace} has been paused for inactivity`,
      html: `
        <p>Hi,</p>
        <p>We paused <strong>${workspace}</strong> because it hasn't been active for a while. ${numLine}</p>
        <p>Nothing is deleted — just log back in and set up a number to pick up right where you left off. If you don't reactivate, the workspace will be permanently closed after a further period of inactivity.</p>
        <p>— The Weeber team</p>`,
      tags: [{ name: "type", value: "lifecycle-suspended" }],
    });
  }

  return sendTransactionalEmail({
    to,
    subject: `${workspace} has been closed`,
    html: `
      <p>Hi,</p>
      <p><strong>${workspace}</strong> has been permanently closed after an extended period of inactivity, and its telephony has been fully torn down.</p>
      <p>If this was a mistake or you'd like to start again, just reply to this email or sign up again and we'll help you get set back up.</p>
      <p>— The Weeber team</p>`,
    tags: [{ name: "type", value: "lifecycle-closed" }],
  });
}
