/**
 * Cloudflare Turnstile server-side verification (2026-08-27) — no CAPTCHA integration existed
 * anywhere in this codebase before the demo-call widget needed one. Turnstile over reCAPTCHA
 * per the source plan (docs/product-strategy/real-demo-call-widget-plan-2026-08-26.md): no
 * third-party cookie, free, drop-in widget.
 *
 * Fails CLOSED on any network/parse error — an unverifiable token blocks the call rather than
 * silently letting it through, matching this endpoint's other guardrails (see demo-widget.ts).
 */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken(token: string, remoteIp: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error("[turnstile] TURNSTILE_SECRET_KEY is not set — failing closed, refusing every token");
    return false;
  }
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      console.error(`[turnstile] siteverify returned HTTP ${res.status} — failing closed`);
      return false;
    }
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] siteverify request failed — failing closed:", err);
    return false;
  }
}
