/**
 * Branded HTML email templates for Weeber transactional emails.
 * All templates use inline CSS for email client compatibility.
 * Design: warm paper bg (#FAFAF8), accent (#C4622D), Inter font stack.
 */

const LOGO_URL = "https://weeber.ai/weeber_logo_transparent.png";
const BRAND_COLOR = "#C4622D";
const BG_COLOR = "#FAFAF8";
const TEXT_COLOR = "#1A1A1A";
const MUTED_COLOR = "#6B7280";
const SURFACE_COLOR = "#FFFFFF";

function baseLayout(content: string, unsubscribeLink?: string): string {
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
          <!-- Logo -->
          <tr>
            <td align="center" style="padding:36px 40px 0;">
              <img src="${LOGO_URL}" alt="Weeber" width="120" style="display:block;height:auto;" />
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px 40px 40px;">
              ${content}
            </td>
          </tr>
        </table>
        <!-- Footer -->
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
          <tr>
            <td style="padding:24px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${MUTED_COLOR};line-height:1.5;">
                Weeber &middot; AI voice agents for e-commerce
              </p>
              ${unsubscribeLink ? `<p style="margin:8px 0 0;font-size:12px;color:${MUTED_COLOR};"><a href="${unsubscribeLink}" style="color:${MUTED_COLOR};text-decoration:underline;">Unsubscribe</a></p>` : ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function waitlistConfirmationHtml(input: {
  name?: string | null;
  referralLink: string;
  unsubscribeLink: string;
}): string {
  const greeting = input.name ? `You're on the list, ${input.name}!` : "You're on the list!";
  const content = `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">${greeting}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      We're building AI voice agents that help Shopify merchants recover abandoned carts,
      confirm COD orders, and collect customer feedback — all on autopilot, in natural
      conversation. No robocalls. No scripts. Just smart, human-sounding calls that
      actually convert.
    </p>

    <h2 style="margin:0 0 12px;font-size:16px;font-weight:600;color:${TEXT_COLOR};">What happens next</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="padding:0 8px 8px 0;vertical-align:top;font-size:15px;color:${BRAND_COLOR};font-weight:bold;">&#x2022;</td>
        <td style="padding:0 0 8px;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">Early access invite when we launch — before the public</td>
      </tr>
      <tr>
        <td style="padding:0 8px 8px 0;vertical-align:top;font-size:15px;color:${BRAND_COLOR};font-weight:bold;">&#x2022;</td>
        <td style="padding:0 0 8px;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">Exclusive launch pricing locked in for early supporters</td>
      </tr>
      <tr>
        <td style="padding:0 8px 0 0;vertical-align:top;font-size:15px;color:${BRAND_COLOR};font-weight:bold;">&#x2022;</td>
        <td style="padding:0;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">First to try new AI agents as we add them</td>
      </tr>
    </table>

    <!-- Referral CTA -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BG_COLOR};border-radius:8px;border:1px solid #E8E6E1;">
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:${TEXT_COLOR};">Share your link, move up the list</p>
          <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED_COLOR};">
            Every friend who joins using your link moves you closer to the front.
          </p>
          <a href="${input.referralLink}" style="display:inline-block;background:${BRAND_COLOR};color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:6px;">
            Copy your referral link
          </a>
          <p style="margin:12px 0 0;font-size:12px;color:${MUTED_COLOR};word-break:break-all;">${input.referralLink}</p>
        </td>
      </tr>
    </table>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:${MUTED_COLOR};">
      Questions? Just reply to this email — we read every one.
    </p>
  `;
  return baseLayout(content, input.unsubscribeLink);
}

export function referralNotificationHtml(input: {
  name?: string | null;
  referralLink: string;
  unsubscribeLink: string;
}): string {
  const greeting = input.name ? `Nice one, ${input.name}!` : "Nice one!";
  const content = `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">${greeting}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Someone just joined the Weeber waitlist using your referral link. You're moving up!
    </p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${MUTED_COLOR};">
      Keep sharing to move even closer to the front of the line.
    </p>
    <a href="${input.referralLink}" style="display:inline-block;background:${BRAND_COLOR};color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:6px;">
      Share your link again
    </a>
    <p style="margin:12px 0 0;font-size:12px;color:${MUTED_COLOR};word-break:break-all;">${input.referralLink}</p>
  `;
  return baseLayout(content, input.unsubscribeLink);
}

export function enterpriseInquiryReceiptHtml(input: { name: string }): string {
  const content = `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">Thanks, ${input.name}!</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      We've received your enterprise inquiry and our team will get back to you within 24 hours.
    </p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:${MUTED_COLOR};">
      In the meantime, feel free to reply to this email if you have any additional details to share.
    </p>
  `;
  return baseLayout(content);
}

export function supportTicketReceiptHtml(input: { email: string; subject: string }): string {
  const content = `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${TEXT_COLOR};line-height:1.2;">We got your message</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
      Your support request has been received. We'll follow up at <strong>${input.email}</strong> as soon as possible.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BG_COLOR};border-radius:8px;border:1px solid #E8E6E1;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0;font-size:12px;font-weight:600;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.05em;">Subject</p>
          <p style="margin:4px 0 0;font-size:14px;color:${TEXT_COLOR};">${input.subject}</p>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:${MUTED_COLOR};">
      Need to add more context? Just reply to this email.
    </p>
  `;
  return baseLayout(content);
}
