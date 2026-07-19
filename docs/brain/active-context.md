---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-07-19
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **Native, person-centric leads/records layer shipped (2026-07-19, Phases 1–3):** built the *owned*
  data-of-record layer before bolting on external CRMs. New tables (`leads` deduped by
  `(orgId, phone)`, `leadIntakeSchemas`, `leadApiKeys`; `calls.leadId` plain indexed int, no FK;
  migration `0040_mushy_arclight.sql`). **Phase 1 (owned core):** captured fields promoted
  `capturedState → leads.fields` at `finalizeCall`; insurance `Leads` page (list/search, detail +
  call history, pipeline status, assign advisor, call-now, Excel export, manual add/edit).
  **Phase 2 (edges & config):** `POST /api/leads/ingest` (per-org `wlk_` key auth, schema-validated,
  regulated keys rejected, idempotent upsert; `triggerWorkflow` accepted-but-not-wired until it
  respects DNC/TCPA dial-gates) + per-org/per-agent intake-schema editor. **Phase 3 (reach):**
  public hosted form `/f/:orgId` (**`orgId` is the non-secret write-only form token** — honeypot +
  per-(ip,org) rate limit, no migration) + on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL,
  leads stays source of truth). Scoping decisions in **ADR-061**; plan in
  `product-strategy/native-leads-layer-plan-2026-07-19.md`. Verified: `typecheck` clean · `test`
  **621 pass / 0 fail** · `lint` 0/0 · `build` clean.
- **Integrations strategy set (2026-07-19):** Pipedream on the *inbound* edge (any CRM/form → our
  ingest API), native adapters for *outbound* (CRM mirror). `product-strategy/integrations-strategy-
  and-roadmap-2026-07-19.md`; recipe in `integrations/pipedream-inbound-recipe.md`. **Pipedrive
  native adapter** flagged as the next likely inbound native adapter.
- **Insurance vertical filled out (2026-07-19):** config-driven en/hi/hinglish language variants for
  insurance agents 04–08, plus a new **Final Expense Qualifier + Warm-Transfer** agent (persona 09,
  scoped US/English-only). All 10 insurance agent prompts now live in `docs/agent-prompts/`.
- **Language support: closed/scoped (ADR-060, 2026-07-19)** — see the section below.
- **Still open from 2026-07-18 (carried forward):** adopt **Supabase Realtime** for the dashboard
  (decided `ADR-058`, not built — currently polls `refetchInterval` every 4–5s); **Workflow Canvas
  v4 Phase 3** (flow preview via web call — the merchant canvas editor exists, this is the last
  piece); **set `SENTRY_DSN` on Railway** (Sentry wired, no-op until the env var is set). Everything
  else from the 2026-07-18 session (insurance KPI-mislabel fix, feedback agent live, VoiceOrb
  rebuild, infra review, pricing lock `ADR-057`, docs→brain restructure) shipped — see
  `progress.md` "Closed recently" and `changelog/2026-07.md`.

## Language support: closed, scoped correctly (ADR-060, 2026-07-19)

**B2 — multilingual understanding, not mid-call switching.** The Hindi/Hinglish STT/TTS foundation is
solid and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), and Indic
calls now smart-default to Sarvam automatically (ADR-060, `../voice-quality/language-support.md`).
Mid-call *spoken-language switching* is REJECTED — not an open gap — because flipping the TTS voice
mid-call breaks voice identity, adds latency, and destabilizes the call (one fixed spoken language per
call; STT code-switching understanding is separate and stays). The differentiator is native Hinglish
+ multilingual understanding, not a switching gimmick. Only open B2 item: B2.5 (localized system
messages), minor polish. See `WEEBER-PLAN.md` Phase B and ADR-060.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

- **A1b** — VAD/endpointing audit (don't assume done just because the pipeline works).
- **B2.5** — localize system messages per language (small polish; mid-call switching REJECTED per ADR-060).
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Workflow Canvas v4 Phase 3 (flow preview via web call): awaiting go-ahead to start — the
  merchant canvas editor now exists, so this is the last remaining piece of the v4 plan.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).

_Last updated by: native leads/records layer (Phases 1–3) + integrations strategy + insurance language variants/Final Expense agent session, 2026-07-19._
