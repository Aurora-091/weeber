---
adr: 41
title: "Supabase auth: signup confirmation (link + OTP) + password reset; full waitlist referral system ported from Vocalist"
date: 2026-07-10
status: Accepted
---

## ADR-041 — Supabase auth: signup confirmation (link + OTP) + password reset; full waitlist referral system ported from Vocalist

**Date:** 2026-07-10

**Context — auth:** The merchant login page already had password signin/signup and magic-link
signin, but password signup had a real bug: `supabase.auth.signUp()` returning no session (because
the Supabase project requires email confirmation) was being treated identically to a successful
signup — it navigated to `/app` with no session at all, a broken redirect. There was also no
password-reset flow.

**Decision — auth:** Added a `needs-confirmation` state to the login page for that no-session-after-
signup case, offering both confirmation paths at once (click the emailed link — same
`/app/auth/callback` handler already used for magic links, since Supabase's `detectSessionInUrl`
consumes both token types the same way — or type the 6-digit code inline via
`supabase.auth.verifyOtp({type:"signup"})`), plus a resend action
(`supabase.auth.resend({type:"signup"})`). Added a full forgot-password flow: "Forgot password?" on
the login page -> `resetPasswordForEmail()` -> new `/app/auth/reset-password` page (same
recovery-token-in-URL mechanism, listens for the `PASSWORD_RECOVERY` auth event) ->
`supabase.auth.updateUser({password})`. No backend changes needed — Supabase sends these emails
itself via the project's own email configuration, not Resend (Resend is earmarked for waitlist
emails specifically, a separate, later piece of work per explicit product decision this session).

**Context — waitlist:** The landing page's waitlist form was a bare email-only capture with no
referral mechanism at all. Vocalist (the older Weeber webapp, `github.com/Aurora-091/Vocalist`) has
a full referral system on its waitlist — explicitly approved for direct content/logic reference and
adaptation this session (not a blanket exception to the advisor-only rule on that repo, which still
holds for actual engineering work on Vocalist itself).

**Decision — waitlist:** Ported the full referral mechanic — not the Vocalist files verbatim (that
repo runs Express + raw `ws` + Supabase edge functions on a different design system entirely), but
the mechanic and copy, rebuilt on openvent's own stack (Hono + Drizzle/Postgres + Bun's native
WebSocket, dark-monochrome theme from ADR-039):
- `waitlist_signups` gains `ownReferralCode` (unique, generated per signup — every join gets an
  immediately shareable link), `referralCount` (atomic SQL increment, not read-then-write, to avoid
  losing concurrent referrals to a race), `phone` (optional post-signup follow-up), `unsubscribed` +
  `unsubscribeToken` (separate from the referral code on purpose — a shareable code and an
  unsubscribe credential shouldn't be the same string). Migration `0008_last_shockwave.sql`,
  additive.
- `WAITLIST_DISPLAY_OFFSET` (40) is a vanity display number, same choice Vocalist made (its
  equivalent was 43) — not a real prior-signup count, just avoids "you're signup #1" undercutting the
  "first 100 lock in founder pricing" framing on a fresh list.
- Live count: a second raw Bun WebSocket path (`/api/public/waitlist/ws`), broadcasting on every new
  join. `Bun.serve` takes exactly one `websocket` handler object for the whole server, so this and
  the existing Twilio Media Stream socket (`voice/ws-route.ts`) now share that one object in
  `server.ts`, dispatched by a `data.kind` discriminant (`"voice"` | `"waitlist"`) — each upgrade
  path tags its own socket data, `server.ts` just routes by kind. `GET /api/public/waitlist/count`
  exists as the HTTP fallback for first paint before the socket connects.
- Unsubscribe is a plain HTML response (`GET /api/public/waitlist/unsubscribe?token=`), not a React
  route — it's meant to be opened directly from an email link, no frontend involvement needed.
- Frontend: landing page's waitlist section replaced entirely (not a separate `/waitlist` route, per
  explicit direction) — name+email form, `?ref=` capture on mount, a success dialog with
  position/count, optional phone capture, and the referral link with copy + native share.
  `useWaitlistCount.ts` mirrors Vocalist's reconnect-with-backoff hook, adapted to this repo's
  `API_BASE_URL` seam (ADR-035) instead of a separate `VITE_WS_HOST`.
- Admin `/dashboard/waitlist` gained columns for the new fields (referred-by code, own code,
  referral count, phone, unsubscribed status).

**Consequences:** No existing signups affected (all new columns nullable/defaulted). The WS
dispatch-by-kind change in `server.ts` means any *third* future raw-socket use case follows the same
pattern (tag socket data, add one more `else if` branch) rather than fighting Bun's single-handler
constraint again. Verified: api tsc + 130/130 tests, web tsc + tests + build, openvent-compliance
tsc + 25/25 tests, root lint — all clean.
