---
doc: project-brief
status: evergreen
updated: 2026-07-18
---

# Project brief — what Weeber is (and isn't)

The single-source "why we exist and what's non-negotiable" file. Read once; it changes rarely. For
*current work* see `active-context.md`; for *how the code is laid out* see `../../architecture/README.md`.

## What Weeber is

A **private, multi-vertical voice-AI SaaS** for SMBs — AI phone agents that handle real inbound and
outbound calls (support, cart recovery, COD confirmation, bookings, reminders, feedback). Built on a
fork of the open-source **OpenVent** orchestration framework, extended into an org-scoped product where
the dashboard, agents, tools, metrics, and terminology adapt to the org's **vertical**.

- **Launch vertical:** ecommerce, **Shopify first** (cart recovery + COD confirmation + feedback).
- **On the board:** clinic/healthcare, insurance, hotel — plus more ecommerce platforms
  (WooCommerce, BigCommerce, Dukaan) after Shopify.
- **Positioning:** a vertical "voice workforce," not a horizontal no-code builder. Compliance-first is
  the moat, not a checkbox.
- **Stage:** pre-launch, pre-traction. ~10 real calls all-time, no paying customers yet. **No real
  clients or partners exist** — do not reference any named client/partner as real.

## The stack (the short version — full detail in `../reference/resources.md`)

| Layer | Choice | Where |
|---|---|---|
| Backend | Bun + Hono + Drizzle (`packages/api`) | Railway (Pro, Singapore, 1 replica) |
| Frontend | React + Vite + Tailwind (`packages/web`) | Vercel (Pro) |
| DB | Postgres + `pgvector` + Auth | Supabase (Pro, Small compute, pooled 6543) |
| LLM | Vercel AI Gateway (model-agnostic + failover); Groq alt | — |
| STT | Deepgram / Sarvam / ElevenLabs (per-agent, failover chain) | — |
| TTS | Cartesia / ElevenLabs / Sarvam (per-agent, failover chain) | — |
| Telephony | Twilio (platform + BYO), Plivo (BYO), Exotel (BYO, India) | — |
| Email | Resend (transactional) | — |
| Compliance | `packages/openvent-compliance` (standalone, dependency-free) | — |

Companion repo: **`weebersh`** (Shopify OAuth/webhook bridge). The wire contract lives in
`../reference/contract.md` and must bump in *both* repos when it changes.

## Non-negotiables (the invariants — don't break these)

- **Compliance enforced by default**, never an integration step. DNC has no bypass anywhere, on purpose.
  (ADR-003, ADR-007.)
- **Additive-only DB migrations** — never rename/drop an existing column.
- **State is not the transcript** — durable facts are captured via the `captureField` tool into
  `calls.capturedState`, re-injected each turn. `callerMemory` (cross-call, per phone number) is
  separate. (ADR-012, ADR-023.)
- **Vertical-agnostic seam** — new verticals add `agentTemplates` rows + `orgs.vertical`, not new code
  paths or schema migrations. (ADR-031.) Same principle for new ecommerce platforms.
- **One-way dependency:** `web → api (types only) → compliance`. Frontend HTTP only via
  `web/lib/api.ts`.
- **Provider-abstracted** STT/LLM/TTS/telephony — never lock to one vendor; per-agent/per-call override
  always wins.

## STOP-AND-ASK gates — never decide these unilaterally

1. **`packages/openvent-compliance` changes** — confirm with the user before merging, however small.
2. **Real credentials** (Twilio/Supabase/Deepgram/Cartesia/ElevenLabs/LLM/GitHub) — ask via a secure
   channel; never hardcode or invent placeholders.
3. **Entry-condition branching / trigger-split** (ADR-033) — config-driven vs visual-canvas is still
   open; ask before starting.
4. ~~**Feedback agent persona (`03-feedback-agent.md`)**~~ — **resolved 2026-07-18**: confirmed final
   by the user. `seed.ts`'s `active` flag flipped to `true` (was the only inactive persona of the 5) —
   now live/selectable same as cart-recovery `01` and COD `02`.
5. **Final brand assets** (logo, exact hex beyond `UI-DESIGN-BRIEF.md`'s starting proposal) — placeholder,
   not committed.

Resolved gates (do NOT reopen): hosting = Railway backend + Vercel frontend (ADR-034); payment gateway
= Razorpay first, Dodo later behind an adapter (ADR-034); config storage = DB-backed
`org_agent_configs`/`org_workflow_configs`, not env; "Merchant" is renamed to "User" as the tenant term
(ADR-052); there is no "Phase 2" — everything is in scope, the signal is *sequencing* not scope (ADR-037).

## Glossary (terms an agent will trip on)

- **Org / org-lite** — the tenant. `orgId` scopes `calls`, `scheduledCalls`, `shopifyContacts`, etc.
  "Org-lite" = scoping exists, but per-org Twilio sub-account / DNC / billing are Phase-1 workstreams,
  not all built.
- **User** — the tenant-facing actor (formerly "Merchant", renamed ADR-052). `/app/*` is the
  user-facing surface; `/dashboard/*` is the internal admin panel. Both live in `packages/web`.
- **Vertical** — the business category (`orgs.vertical`) that drives which agents/metrics/terminology
  the dashboard shows.
- **capturedState** — durable facts captured mid-call via `captureField`, per call.
- **callerMemory** — cross-call memory, one row per phone number, merged in as lower-confidence context.
- **Agent template** — a row in `agentTemplates` = a persona + tools + tone for a vertical.
- **weebersh** — the separate Shopify OAuth/webhook bridge repo.
- **The sweep** — the in-process `setInterval` in `server.ts` that polls `scheduledCalls` (and the
  webhook outbox) every minute; the current "queue." No Inngest/Trigger.dev.
