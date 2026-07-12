/**
 * Transactional email via Resend — thin wrapper for single-send emails
 * (waitlist confirmation, support receipts, etc.). Broadcasts use a
 * separate batch path in broadcasts.ts.
 *
 * Gracefully no-ops when RESEND_API_KEY is unset — logs once, never
 * crashes. This lets dev/staging environments run without email config.
 */
import { resilientCall } from "../voice/integrations/resilient-fetch";

let warnedMissing = false;

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
};

export async function sendTransactionalEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!warnedMissing) {
      console.warn("[email] RESEND_API_KEY not configured — transactional emails disabled");
      warnedMissing = true;
    }
    return false;
  }

  const from = process.env.RESEND_FROM_EMAIL || "hello@weeber.ai";
  const replyTo = input.replyTo || from;

  const result = await resilientCall(
    async (signal) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: input.to,
          reply_to: replyTo,
          subject: input.subject,
          html: input.html,
          tags: input.tags,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json();
    },
    { integration: "resend-transactional", timeoutMs: 8_000, maxAttempts: 2 },
  );

  if (!result.ok) {
    console.error(`[email] Failed to send to ${input.to}: ${result.message}`);
  }
  return result.ok;
}
