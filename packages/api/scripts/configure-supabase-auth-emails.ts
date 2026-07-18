/**
 * One-off admin script: points Supabase Auth's own mailer at Resend's SMTP relay (so
 * confirm-signup/magic-link/recovery/email-change emails send from hello@weeber.ai instead of
 * Supabase's shared default sender) and pushes Weeber-branded HTML for all four templates.
 *
 * This is NOT part of the running app or its Railway env — it's a Supabase project *setting*,
 * changed once (and re-run only when you want to tweak the templates again). Uses the Supabase
 * Management API (https://api.supabase.com), which needs a personal access token, not the
 * project's own SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx \
 *   SUPABASE_PROJECT_REF=xxxxxxxxxxxxxxxxxxxx \
 *   RESEND_API_KEY=re_xxx \
 *   bun run packages/api/scripts/configure-supabase-auth-emails.ts
 *
 * Where to get each value:
 *   - SUPABASE_ACCESS_TOKEN: https://supabase.com/dashboard/account/tokens (personal access token)
 *   - SUPABASE_PROJECT_REF: Project Settings > General > Reference ID (also the subdomain in
 *     your SUPABASE_URL, e.g. https://<ref>.supabase.co)
 *   - RESEND_API_KEY: the same key already set in Railway for the app's own transactional email
 *
 * Optional overrides:
 *   SMTP_SENDER_EMAIL (default hello@weeber.ai), SMTP_SENDER_NAME (default "Weeber")
 */
import {
  CONFIRMATION_SUBJECT,
  CONFIRMATION_HTML,
  MAGIC_LINK_SUBJECT,
  MAGIC_LINK_HTML,
  RECOVERY_SUBJECT,
  RECOVERY_HTML,
  EMAIL_CHANGE_SUBJECT,
  EMAIL_CHANGE_HTML,
} from "./supabase-auth-email-templates";

async function main() {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const resendApiKey = process.env.RESEND_API_KEY;
  const senderEmail = process.env.SMTP_SENDER_EMAIL || "hello@weeber.ai";
  const senderName = process.env.SMTP_SENDER_NAME || "Weeber";

  const missing = [
    !accessToken && "SUPABASE_ACCESS_TOKEN",
    !projectRef && "SUPABASE_PROJECT_REF",
    !resendApiKey && "RESEND_API_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`Missing required env var(s): ${missing.join(", ")}. See the header comment in this file for how to get each one.`);
    process.exit(1);
  }

  const body = {
    // SMTP relay — Resend's documented SMTP settings (resend.com/docs/send-with-supabase-smtp).
    smtp_host: "smtp.resend.com",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: resendApiKey,
    smtp_admin_email: senderEmail,
    smtp_sender_name: senderName,

    // Branded subjects + HTML for every Auth-mailer template this app actually uses
    // (confirm-signup, OTP sign-in code, password recovery) plus email-change for completeness.
    mailer_subjects_confirmation: CONFIRMATION_SUBJECT,
    mailer_templates_confirmation_content: CONFIRMATION_HTML,
    mailer_subjects_magic_link: MAGIC_LINK_SUBJECT,
    mailer_templates_magic_link_content: MAGIC_LINK_HTML,
    mailer_subjects_recovery: RECOVERY_SUBJECT,
    mailer_templates_recovery_content: RECOVERY_HTML,
    mailer_subjects_email_change: EMAIL_CHANGE_SUBJECT,
    mailer_templates_email_change_content: EMAIL_CHANGE_HTML,
  };

  console.log(`Configuring Supabase Auth SMTP + email templates for project ${projectRef} (sender: ${senderName} <${senderEmail}>)...`);

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Supabase Management API returned ${res.status}: ${text.slice(0, 1000)}`);
    process.exit(1);
  }

  console.log("Done. Supabase Auth emails (confirm-signup, sign-in code, password reset, email change) now send via Resend from " + senderEmail + ".");
  console.log("Send yourself a test sign-in code from the login page to confirm delivery + formatting.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
