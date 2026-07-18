---
adr: 52
title: "'Merchant' renamed to 'User' as the tenant-facing actor term (2026-07-13)"
date: 2026-07-13
status: Accepted
---

## ADR-052: "Merchant" renamed to "User" as the tenant-facing actor term (2026-07-13)

**Context:** Weeber is multi-vertical (Shopify today, Clinic next, Insurance/Hospital planned).
The tenant-facing app surface's internal naming (`MerchantShell`, `requireMerchantSession`,
`merchant-session.ts`, `MERCHANT-APP-PAGE-MAP.md`, etc.) hardcoded "merchant" — accurate for a
Shopify store owner, meaningless for a clinic or an insurance company. User explicitly flagged
this: "shopify merchants are one of our users... they are user like our upcoming clients like
insurance and hospitals." Rather than treat this as a minor copy issue, it's a real signal that
the platform's own vocabulary was still Shopify-shaped even though the data model (`orgs`,
`vertical` column, `VerticalDefinition` config) was already correctly vertical-neutral.

**Term chosen: "User".** Two other candidates were ruled out on collision grounds, not
preference: "Customer" was already taken by `verticals.ts`'s `glossary.customer` (the org's own
end-customers/patients being called — the opposite end of the relationship), and inventing a
third term ("Client") when the admin dashboard's Users page (`pages/dashboard/users.tsx`) already
calls exactly these people "Users" would have created inconsistency instead of fixing it. "User"
was the zero-new-vocabulary option.

**Scope: naming only, not a data-model or behavior change.** The DB schema needed no migration —
table/column names never said "merchant" anywhere. This was purely code identifiers (~55 files),
file names, and living reference docs. Historical records (`changelog.md`, `DECISIONS.md`,
`AGENT-CONSOLE-UI-PLAN.md`, `project_analysis.md`, `audit/*.md`) were deliberately left
untouched — rewriting a past changelog entry or ADR to use today's vocabulary would misrepresent
what was actually true at the time it was written. Genuine Shopify-vendor terminology was also
left alone: the three Shopify-vertical agent prompt docs' `{{merchant_name}}` template variable
(Shopify's own word for a store owner, appropriate in a Shopify-specific system prompt) and two
narrative copy references to real Shopify merchants in `landing.tsx` and `email-templates.ts`.

**Infra decision: backward-compat shim over a coordinated cutover.** The live `weeber-merchant`
Vercel project was created with `VITE_APP_SURFACE=merchant` during the subdomain split (ADR-051's
era). Rather than requiring the code push and the Vercel env var change to land in the same
instant (a real outage-window risk on a live production surface), `app.tsx` and
`lib/route-base.ts` both normalize the legacy `"merchant"` value to `"user"` at the point the env
var is read. Verified both values produce byte-identical-size builds. The Vercel project rename
and env var flip remain a manual dashboard step (no rename-project or update-env-var action
exists in the available Vercel API tooling) — the shim means there's no urgency or ordering
requirement on when that happens. Remove the shim once confirmed flipped.
