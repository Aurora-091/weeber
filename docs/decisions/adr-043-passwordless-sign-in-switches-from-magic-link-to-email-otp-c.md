---
adr: 43
title: "Passwordless sign-in switches from magic link to email OTP code; Weeber-branded auth emails"
date: 2026-07-10
status: Accepted
---

## ADR-043 — Passwordless sign-in switches from magic link to email OTP code; Weeber-branded auth emails

**Date:** 2026-07-10

**Context:** The magic-link flow is fragile in the split deploy because it depends on the Supabase
redirect-URL allowlist matching the frontend's live origin — and that origin has been churning
(weeber.ai bought but not yet wired to the current project, multiple `*.vercel.app` deployment
URLs). A stale allowlist or Site URL silently breaks every sign-in link. The auth emails were also
stock Supabase templates with no Weeber branding. (Same session also root-caused the "session may
have expired" error screen to a missing `VITE_API_BASE_URL` on the Vercel build — an env/redeploy
fix, no code change; noted here because it's why the magic-link flow was under scrutiny.)

**Decision:** Passwordless sign-in is a 6-digit email OTP, not a magic link — the code is verified
inline on the login page (`verifyOtp({ type: "email" })`), which has zero dependency on redirect
URLs, Site URL, or which domain the frontend is on this week. Supabase supports putting both
`{{ .ConfirmationURL }}` and `{{ .Token }}` in one template (both would work from the same email),
but the sign-in and signup-confirmation templates are deliberately code-ONLY so there is no
broken-link path at all. Password reset is the one flow that keeps its link (the
`/app/auth/reset-password` page works off the recovery token in the URL, per ADR-041), so the
redirect allowlist now only matters there. All three templates (`supabase/templates/*.html`) are
Weeber-branded: dark monochrome per ADR-039, tokens hand-converted to email-safe hex (bg `#0A0A0A`,
card `#171717`, text `#E5E5E5`, muted `#8A8A8A`, border `#262626`), table-based inline-styled HTML,
text wordmark only (no logo asset — final brand assets are still STOP-AND-ASK item #2). Wired into
`supabase/config.toml` (`[auth.email.template.*]`); the hosted project needs the same HTML applied
via `supabase config push` or pasted into Dashboard → Authentication → Emails — the committed files
are the source of truth either way.

**Consequences:** `/app/auth/callback` stays routed (already-sent emails, possible future OAuth)
but nothing links to it anymore. The login page's "Magic link" tab is now "Email code" with a
send-then-verify two-step; `signInWithOtp` still auto-creates users (unchanged default), and a
brand-new user entering that flow gets the confirmation template's code, which the same
`type: "email"` verify accepts. Sign-in emails can no longer break from domain changes;
password-reset emails still can — when the real domain goes live, update Site URL + the allowlist
for that one flow.
