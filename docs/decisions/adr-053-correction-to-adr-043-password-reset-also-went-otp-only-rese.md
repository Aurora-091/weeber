---
adr: 53
title: "Correction to ADR-043: password reset also went OTP-only; `reset-password.tsx` kept as speculative scaffolding (2026-07-13)"
date: 2026-07-13
status: Correction
---

## ADR-053 — Correction to ADR-043: password reset also went OTP-only; `reset-password.tsx` kept as speculative scaffolding (2026-07-13)

**Context:** Audit #03 found that ADR-043's stated decision — *"Password reset is the one flow that keeps
its link... the redirect allowlist now only matters there"* — is no longer true. At some point after
ADR-043 was written (2026-07-10), the hosted Supabase project's recovery email template was replaced with
a fully code-based one (`supabase/templates/recovery.html` now renders only `{{ .Token }}`, no
`{{ .ConfirmationURL }}` at all), and `login.tsx`'s forgot-password flow was built as a complete 3-step
inline OTP verification (`resetPasswordForEmail` → `verifyOtp({ type: "recovery" })` →
`updateUser({ password })`) — no link involved anywhere. That change shipped as part of the
2026-07-13 hosted-Supabase-config-sync work (`cbf976d`, changelog "Hosted Supabase auth config synced"),
referenced only as "ADR-043 extended" in the template file's own comment, with no dedicated decision
record explaining the change. This ADR is that missing record, and formally supersedes ADR-043's now-false
claim.

**Decision:** All three Supabase auth email flows (sign-in, signup confirmation, password reset) are
code-only OTP as of 2026-07-13. None of them depend on the redirect-URL allowlist, Site URL, or which
domain the frontend happens to be on. The allowlist (`supabase/config.toml`'s
`additional_redirect_urls`) is kept clean regardless (audit hygiene + covers `/auth/callback` and any
future OAuth flow), but no *live* flow reads it today.

**On `packages/web/src/web/pages/app/reset-password.tsx`:** this page (and its route,
`appPath("/auth/reset-password")` in `app.tsx`) is unreachable through the normal product flow — nothing
sends a link that lands on it anymore. Explicitly decided to **keep it** rather than delete it, as
speculative scaffolding for a future OAuth provider (Google/Microsoft sign-in), which — if ever added —
would plausibly reuse this page's `onAuthStateChange`/`PASSWORD_RECOVERY`-adjacent session-detection
pattern for its own callback landing. This is a deliberate "keep unused code because it's cheap and might
be reused" call, not an oversight — flag it for actual deletion only if a future audit finds it's still
unused once OAuth is either built (and reuses it) or is decisively taken off the roadmap.

**Consequence:** no code changed as part of this ADR — it's a documentation correction plus an explicit
decision to keep already-existing dead code. Future readers of ADR-043 should treat its "keeps its link"
claim as historical (true as of 2026-07-10, false as of 2026-07-13) rather than current.
