/**
 * Branded HTML for Supabase Auth's own emails — confirm-signup, magic-link sign-in code,
 * password recovery, and email-change. These are NOT sent by our app (see email.ts /
 * email-templates.ts for that path) — Supabase Auth's own mailer renders and sends these
 * whenever `supabase.auth.signUp`, `signInWithOtp`, `resetPasswordForEmail`, or
 * `updateUser({ email })` runs (see packages/web/src/web/pages/app/login.tsx). Pushed into the
 * project via the Management API by configure-supabase-auth-emails.ts, not deployed with the app.
 *
 * Written in Go html/template syntax (Supabase's templating engine), not TS template literals —
 * `{{ .Token }}` etc. are placeholders Supabase fills in at send time, not JS interpolation.
 *
 * Every flow in this app is OTP-code based, not link-based (ADR-043, see login.tsx comments) —
 * so every template leads with the 6-digit `{{ .Token }}` in a large, easy-to-read block, not a
 * "click here" button as the primary action. Style matches packages/api/src/app/email-templates.ts:
 * warm paper bg (#FAFAF8), accent (#C4622D), Inter font stack, 560px card.
 */

const LOGO_URL = "https://weeber.ai/weeber_logo_transparent.png";
const BRAND_COLOR = "#C4622D";
const BG_COLOR = "#FAFAF8";
const TEXT_COLOR = "#1A1A1A";
const MUTED_COLOR = "#6B7280";
const SURFACE_COLOR = "#FFFFFF";

function baseLayout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weeber</title>
</head>
<body style="margin:0;padding:0;background:${BG_COLOR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;color:${TEXT_COLOR};-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BG_COLOR};">
    <tr>
      <td align="center" style="padding:48px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:${SURFACE_COLOR};border-radius:12px;border:1px solid #E8E6E1;overflow:hidden;">
          <tr>
            <td align="center" style="padding:36px 40px 0;">
              <img src="${LOGO_URL}" alt="Weeber" width="120" style="display:block;height:auto;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 40px;">
              ${content}
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
          <tr>
            <td style="padding:24px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${MUTED_COLOR};line-height:1.5;">
                Weeber &middot; AI voice agents for e-commerce
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function otpBlock(): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BG_COLOR};border-radius:8px;border:1px solid #E8E6E1;border-top:3px solid ${BRAND_COLOR};margin:0 0 24px;">
      <tr>
        <td align="center" style="padding:24px;">
          <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.08em;">Your code</p>
          <p style="margin:0;font-size:36px;font-weight:800;letter-spacing:0.12em;color:${TEXT_COLOR};font-family:'SF Mono',Consolas,monospace;">{{ .Token }}</p>
        </td>
      </tr>
    </table>`;
}

export const CONFIRMATION_SUBJECT = "Confirm your Weeber account";
export const CONFIRMATION_HTML = baseLayout(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">Confirm your account</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Enter this code to confirm <strong>{{ .Email }}</strong> and finish setting up your Weeber account.
    </p>
    ${otpBlock()}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">
      This code expires shortly. If you didn't try to create a Weeber account, you can safely ignore this email.
    </p>
`);

export const MAGIC_LINK_SUBJECT = "Your Weeber sign-in code";
export const MAGIC_LINK_HTML = baseLayout(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">Your sign-in code</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Enter this code to sign in to Weeber as <strong>{{ .Email }}</strong>.
    </p>
    ${otpBlock()}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">
      This code expires shortly. If you didn't request this, you can safely ignore this email — nobody
      can sign in without the code.
    </p>
`);

export const RECOVERY_SUBJECT = "Reset your Weeber password";
export const RECOVERY_HTML = baseLayout(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">Reset your password</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Enter this code to reset the password for <strong>{{ .Email }}</strong>.
    </p>
    ${otpBlock()}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">
      This code expires shortly. If you didn't request a password reset, you can safely ignore this
      email — your password won't change.
    </p>
`);

export const EMAIL_CHANGE_SUBJECT = "Confirm your new email for Weeber";
export const EMAIL_CHANGE_HTML = baseLayout(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">Confirm your new email</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Enter this code to confirm this address as the new email for your Weeber account.
    </p>
    ${otpBlock()}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">
      This code expires shortly. If you didn't request this change, contact us right away by replying
      to this email.
    </p>
`);
