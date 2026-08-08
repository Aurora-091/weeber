# Architecture Decision Records — Index

The *why* behind consequential technical and product decisions in this repo — one entry per
decision, dated, with context, the decision itself, and its consequences/tradeoffs. Loosely
follows Michael Nygard's [ADR pattern](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
A shipped ADR is never rewritten; if a decision is later reversed, a new ADR supersedes it and says so.

> Split from the former monolithic `DECISIONS.md` (2026-07-18) so agents load one decision at a time. Each ADR is now its own file with frontmatter (number, title, date, status). Append new decisions as `adr-NNN-slug.md` and add a row here.


| # | Decision | Date | Status |
|---|---|---|---|
| [ADR-001](./adr-001-self-hosted-pipeline-over-a-managed-voice-agent-platform.md) | Self-hosted pipeline over a managed voice-agent platform | 2026-07-04 | Accepted |
| [ADR-002](./adr-002-cartesia-as-the-default-tts-provider-elevenlabs-kept-as-an-o.md) | Cartesia as the default TTS provider, ElevenLabs kept as an option | 2026-07-04 | Accepted |
| [ADR-003](./adr-003-compliance-is-enforced-by-default-not-left-as-an-integration.md) | Compliance is enforced by default, not left as an integration step | 2026-07-04 | Accepted |
| [ADR-004](./adr-004-hipaa-support-is-a-guardrail-not-a-certification.md) | HIPAA support is a guardrail, not a certification | 2026-07-04 | Accepted |
| [ADR-005](./adr-005-groq-added-as-a-swappable-llm-provider-behind-the-same-patte.md) | Groq added as a swappable LLM provider behind the same pattern as TTS | 2026-07-04 | Accepted |
| [ADR-006](./adr-006-workflows-as-code-first-json-config-not-a-visual-builder.md) | Workflows as code-first JSON config, not a visual builder | 2026-07-04 | Accepted |
| [ADR-007](./adr-007-national-dnc-registry-integration-deferred-internal-list-is-.md) | National DNC Registry integration deferred; internal list is the enforced mechanism today | 2026-07-04 | Accepted |
| [ADR-008](./adr-008-public-endpoint-via-a-free-cloudflare-quick-tunnel-is-a-temp.md) | Public endpoint via a free Cloudflare quick-tunnel is a temporary stopgap, not a solution | 2026-07-04 | Accepted |
| [ADR-009](./adr-009-evaluated-and-rejected-livekit-agents-as-an-orchestration-la.md) | Evaluated and rejected LiveKit Agents as an orchestration layer | 2026-07-04 | Accepted |
| [ADR-010](./adr-010-extracted-the-compliance-layer-into-a-standalone-framework-a.md) | Extracted the compliance layer into a standalone, framework-agnostic package | 2026-07-05 | Accepted |
| [ADR-011](./adr-011-v1-3-hardening-pass-auth-signature-validation-retry-cap-fix-.md) | v1.3 hardening pass: auth, signature validation, retry-cap fix, rate limiting | 2026-07-05 | Accepted |
| [ADR-012](./adr-012-structured-call-state-as-ground-truth-not-the-transcript.md) | Structured call state as ground truth, not the transcript | 2026-07-05 | Accepted |
| [ADR-013](./adr-013-named-cloudflare-tunnel-replaces-the-quick-tunnel-supervisor.md) | Named Cloudflare tunnel replaces the quick-tunnel supervisor | 2026-07-05 | Accepted |
| [ADR-014](./adr-014-reverted-adr-013-back-to-the-quick-tunnel-named-tunnel-parke.md) | Reverted ADR-013: back to the quick-tunnel, named tunnel parked | 2026-07-05 | Superseded/Reverted |
| [ADR-015](./adr-015-open-core-framework-not-a-pure-library-or-a-pure-hosted-plat.md) | Open-core framework, not a pure library or a pure hosted platform | 2026-07-05 | Accepted |
| [ADR-016](./adr-016-self-hosted-reframed-as-a-three-tier-spectrum-not-a-binary-c.md) | "Self-hosted" reframed as a three-tier spectrum, not a binary claim | 2026-07-05 | Accepted |
| [ADR-017](./adr-017-compliance-audit-trail-export.md) | Compliance audit-trail export | 2026-07-06 | Accepted |
| [ADR-018](./adr-018-switch-from-mit-to-a-fair-code-license-vent-sustainable-use-.md) | Switch from MIT to a fair-code license (Vent Sustainable Use License) | 2026-07-07 | Accepted |
| [ADR-019](./adr-019-full-rebrand-from-vent-to-openvent.md) | Full rebrand from "Vent" to "OpenVent" | 2026-07-08 | Accepted |
| [ADR-020](./adr-020-landing-page-storytelling-rebuild-real-logos-scroll-driven-d.md) | Landing page storytelling rebuild: real logos, scroll-driven diagram, drop stale demo data | 2026-07-08 | Accepted |
| [ADR-021](./adr-021-telephony-provider-abstraction-deferred-scoped-documented-no.md) | Telephony provider abstraction: deferred, scoped, documented (no code this round) | 2026-07-08 | Accepted |
| [ADR-022](./adr-022-per-call-latency-breakdown-first-value-only-persisted-once-a.md) | Per-call latency breakdown: first-value-only, persisted once at call end | 2026-07-08 | Accepted |
| [ADR-023](./adr-023-cross-call-memory-flat-key-value-overlay-merged-not-replaced.md) | Cross-call memory: flat key/value overlay, merged not replaced | 2026-07-08 | Accepted |
| [ADR-024](./adr-024-fixed-a-repo-wide-silent-typecheck-gap-tsc-noemit-was-checki.md) | Fixed a repo-wide silent typecheck gap: `tsc --noEmit` was checking nothing | 2026-07-08 | Accepted |
| [ADR-025](./adr-025-multi-user-dashboard-auth-labeled-api-keys-not-accounts.md) | Multi-user dashboard auth: labeled API keys, not accounts | 2026-07-08 | Accepted |
| [ADR-026](./adr-026-redis-backed-session-storage-optional-opt-in-async-interface.md) | Redis-backed session storage: optional, opt-in, async interface either way | 2026-07-08 | Accepted |
| [ADR-027](./adr-027-docs-landing-page-sync-after-the-four-item-round.md) | Docs/landing-page sync after the four-item round | 2026-07-08 | Accepted |
| [ADR-028](./adr-028-relicense-from-the-vent-sustainable-use-license-back-to-apac.md) | Relicense from the Vent Sustainable Use License back to Apache 2.0, protect the name via trademark instead | 2026-07-09 | Accepted |
| [ADR-029](./adr-029-strip-runable-scaffold-leftovers-analytics-beacon-dead-templ.md) | Strip Runable-scaffold leftovers: analytics beacon, dead template files, placeholder identifiers | 2026-07-09 | Accepted |
| [ADR-030](./adr-030-fork-into-a-private-repo-as-weeber-s-backend-add-org-lite-sc.md) | Fork into a private repo as Weeber's backend, add org-lite scoping + the Shopify vertical (cart recovery, COD confirmation, feedback) | 2026-07-09 | Accepted |
| [ADR-031](./adr-031-design-system-codebase-structure-and-vertical-agnostic-data-.md) | Design system, codebase structure, and vertical-agnostic data model for Weeber's dashboards | 2026-07-09 | Accepted |
| [ADR-032](./adr-032-weeber-product-design-system-arc-like-warm-paper-theme-confi.md) | Weeber product design system: Arc-like warm paper theme, confirmed by explicit UI/UX round | 2026-07-09 | Accepted |
| [ADR-033](./adr-033-klaviyo-shopify-flow-research-identified-a-real-gap-entry-co.md) | Klaviyo/Shopify Flow research: identified a real gap (entry-condition branching), generalized beyond Shopify | 2026-07-09 | Accepted |
| [ADR-034](./adr-034-stack-finalization-supabase-postgres-as-the-primary-db-railw.md) | Stack finalization: Supabase Postgres as the primary DB, Railway + Vercel confirmed, Razorpay-first billing (India GTM) | 2026-07-10 | Accepted |
| [ADR-035](./adr-035-backend-separation-prepare-the-seam-now-split-later.md) | Backend separation: prepare the seam now, split later | 2026-07-10 | Accepted |
| [ADR-036](./adr-036-backend-split-executed-packages-api-weeber-api-packages-web-.md) | Backend split executed: `packages/api` (@weeber/api) + `packages/web` (@weeber/web) | 2026-07-10 | Accepted |
| [ADR-037](./adr-037-phase-2-merged-into-phase-1-one-backlog-sequencing-and-gates.md) | Phase 2 merged into Phase 1: one backlog, sequencing and gates preserved | 2026-07-10 | Accepted |
| [ADR-038](./adr-038-india-telephony-exotel-over-twilio-and-the-number-series-rea.md) | India telephony: Exotel over Twilio, and the number-series reality | 2026-07-10 | Accepted |
| [ADR-039](./adr-039-weeber-product-theme-recolored-dark-fully-monochrome-overrid.md) | Weeber product theme recolored: dark, fully monochrome (overrides ADR-032) | — | Supersedes prior |
| [ADR-040](./adr-040-configurable-per-agent-language-multi-provider-stt-tts-sarva.md) | Configurable per-agent language + multi-provider STT/TTS (Sarvam added) | 2026-07-10 | Accepted |
| [ADR-041](./adr-041-supabase-auth-signup-confirmation-link-otp-password-reset-fu.md) | Supabase auth: signup confirmation (link + OTP) + password reset; full waitlist referral system ported from Vocalist | 2026-07-10 | Accepted |
| [ADR-042](./adr-042-per-org-twilio-isolation-real-sub-accounts-byo-sid-auth-toke.md) | Per-org Twilio isolation: real sub-accounts + BYO (SID + auth token + number) | 2026-07-10 | Accepted |
| [ADR-043](./adr-043-passwordless-sign-in-switches-from-magic-link-to-email-otp-c.md) | Passwordless sign-in switches from magic link to email OTP code; Weeber-branded auth emails | 2026-07-10 | Accepted |
| [ADR-044](./adr-044-fixed-theme-weeber-light-dark-color-inversion-bug.md) | Fixed `.theme-weeber` light/dark color inversion bug | 2026-07-11 | Accepted |
| [ADR-045](./adr-045-weeber-marketing-waitlist-page-faithful-visual-port-from-voc.md) | Weeber marketing/waitlist page: faithful visual port from Vocalist, real brand assets | 2026-07-11 | Accepted |
| [ADR-046](./adr-046-dynamic-voice-picker-with-instant-per-voice-preview-replaces.md) | Dynamic voice picker with instant per-voice preview (replaces free-text voice ID) | 2026-07-11 | Accepted |
| [ADR-047](./adr-047-setup-modal-not-a-setup-page-vertical-driven-dashboard-as-th.md) | Setup modal, not a setup page — vertical-driven dashboard as the default landing route (2026-07-12) | 2026-07-12 | Accepted |
| [ADR-048](./adr-048-plivo-exotel-byo-telephony-credential-layer-only-2026-07-12.md) | Plivo + Exotel BYO telephony, credential layer only (2026-07-12) | 2026-07-12 | Accepted |
| [ADR-049](./adr-049-real-plivo-exotel-call-transport-provider-wire-format-abstra.md) | Real Plivo/Exotel call transport — provider wire-format abstraction + a correction (2026-07-12) | 2026-07-12 | Accepted |
| [ADR-050](./adr-050-merchant-impersonation-removed-entirely-2026-07-12.md) | Merchant impersonation removed entirely (2026-07-12) | 2026-07-12 | Accepted |
| [ADR-051](./adr-051-agent-preview-drawer-live-voice-test-call-is-a-parallel-sand.md) | Agent Preview drawer — live voice test call is a parallel sandbox handler, not a 4th telephony provider (2026-07-12) | 2026-07-12 | Accepted |
| [ADR-052](./adr-052-merchant-renamed-to-user-as-the-tenant-facing-actor-term-202.md) | "Merchant" renamed to "User" as the tenant-facing actor term (2026-07-13) | 2026-07-13 | Accepted |
| [ADR-053](./adr-053-correction-to-adr-043-password-reset-also-went-otp-only-rese.md) | Correction to ADR-043: password reset also went OTP-only; `reset-password.tsx` kept as speculative scaffolding (2026-07-13) | 2026-07-13 | Correction |
| [ADR-054](./adr-054-dialogs-sheets-dropdowns-tooltips-selects-render-inside-the-.md) | Dialogs/sheets/dropdowns/tooltips/selects render inside the themed shell via a portal-container context (2026-07-13) | 2026-07-13 | Accepted |
| [ADR-055](./adr-055-agent-console-full-window-layout-via-a-new-appshell-fullblee.md) | Agent console: full-window layout via a new `AppShell` `fullBleed` opt-out (2026-07-13) | 2026-07-13 | Accepted |
| [ADR-056](./adr-056-correction-the-38-pre-existing-test-failures-baseline-cited-.md) | Correction: the "38 pre-existing test failures" baseline cited across many prior sessions was a false signal, not real bugs (2026-07-16) | 2026-07-16 | Correction |
| [ADR-057](./adr-057-pricing-locked-internal-only-not-deployed-geo-differentiated.md) | Pricing locked (internal only, not deployed): geo-differentiated tiers, split by voice cost, minutes not calls (2026-07-18) | 2026-07-18 | Accepted |
| [ADR-058](./adr-058-adopt-supabase-realtime-for-live-dashboard-updates-2026-07-18.md) | Adopt Supabase Realtime for live dashboard updates, replacing polling (2026-07-18) | 2026-07-18 | Accepted (not yet implemented) |
| [ADR-059](./adr-059-testing-infrastructure-web-component-tests-coverage-and-e2e.md) | Testing infrastructure: web component tests (happy-dom), opt-in coverage, and a secret-free Playwright E2E (2026-07-19) | 2026-07-19 | Accepted |
| [ADR-060](./adr-060-indic-language-smart-provider-default-sarvam-and-mid-call-switching-rejected.md) | Indic-language calls smart-default to Sarvam when no provider is chosen; mid-call spoken-language switching stays rejected (2026-07-19) | 2026-07-19 | Accepted |
| [ADR-061](./adr-061-leads-layer-lean-phase-1-relabel-and-orgid-as-hosted-form-token.md) | Native leads layer: lean Phase 1 (ingest + api-keys re-labelled to Phase 2); orgId is the public hosted-form token; Shopify Orders migration deferred (2026-07-19) | 2026-07-19 | Accepted |
| [ADR-062](./adr-062-compliance-audit-trail-legal-shape-and-dial-time-consent.md) | Compliance audit trail — legal-shape completion + dial-time consent enforcement (2026-07-30) | 2026-07-30 | Accepted (Phase I implemented; II–III deferred) |
| [ADR-063](./adr-063-turn-detection-seam-shipped-eot-model-deferred-behind-a-gate.md) | Turn-detection seam shipped (heuristic default, flag-gated, no migration); the EOT model is deferred behind a gate — Phase II health data + staging isolation (2026-07-31) | 2026-07-31 | Accepted |
| [ADR-064](./adr-064-the-merchant-owns-the-discount-amount-the-model-owns-only-the-timing.md) | The merchant owns the discount amount; the model owns only the timing — non-registration as the enforcement mechanism (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-065](./adr-065-values-not-placeholders-prompts-instruct-fact-blocks-supply-values.md) | Values, not placeholders — seeded personas carry instructions only; fact blocks carry values; a runtime scrub is the last line of defense (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-066](./adr-066-a-tool-that-acts-on-a-real-world-entity-is-bound-to-that-entity-server-side.md) | A tool that acts on a real-world entity is bound to that entity server-side — the model never names the target of a destructive action (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-067](./adr-067-one-composition-path-and-a-compiled-prompt-panel-the-editor-shows-what-ships.md) | One composition path, and an editor that shows what actually ships — compiled prompt panel, tool consequence groups, guardrail consequence text (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-068](./adr-068-product-layout-responds-to-the-content-column-not-the-viewport.md) | Product layout responds to the content column, not the viewport — `@container` on AppShell's `<main>`, container variants in every product route (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-069](./adr-069-the-caller-identity-a-tool-writes-to-comes-from-the-carrier-not-the-model.md) | The caller identity a tool writes to comes from the carrier, not the model — `crmSync` upsert key bound server-side from `humanNumber` (2026-08-01) | 2026-08-01 | Accepted |
| [ADR-070](./adr-070-one-voice-per-call-failover-is-sticky-and-a-voice-id-never-crosses-providers.md) | One voice per call: TTS failover is sticky for the rest of the call, and a voice ID never crosses providers (2026-08-05) | 2026-08-05 | Accepted |
| [ADR-071](./adr-071-ending-a-call-is-a-local-guarantee-the-provider-rest-hangup-is-best-effort.md) | Ending a call is a local guarantee — closing the media WebSocket is authoritative, the provider REST hangup is best-effort and cannot throw (2026-08-05) | 2026-08-05 | Accepted |
| [ADR-072](./adr-072-a-provider-contract-is-what-the-server-accepts-not-what-its-docs-say.md) | A provider contract is what the server accepts, not what its docs say — and a provider that hears nothing must not report itself healthy (2026-08-05) | 2026-08-05 | Accepted |
| [ADR-073](./adr-073-a-repair-path-with-no-caller-is-not-a-repair-path.md) | A repair path with no caller is not a repair path — `syncNumberWebhooksForOrg` gets an admin route, manual on purpose (2026-08-06) | 2026-08-06 | Accepted |
| [ADR-074](./adr-074-clearing-a-timer-does-not-cancel-a-timeout-that-already-fired.md) | Clearing a timer does not cancel a timeout that already fired — `callerSpeechEpoch` re-checked after every await in `handleSilenceTimeout` (2026-08-06) | 2026-08-06 | Accepted |
| [ADR-075](./adr-075-a-required-check-must-assert-what-succeeded-not-what-failed.md) | A required check must assert what succeeded, not what failed — `ci-success` allow-lists `result == "success"` so a gate cannot go green on jobs that never ran (2026-08-08) | 2026-08-08 | Accepted |
