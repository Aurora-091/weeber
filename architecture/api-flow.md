# API Flow — Shopify webhook to outbound call

How a Shopify event turns into a real outbound voice call. This is the concrete path for the
Cart Recovery and COD Confirmation agents (see `WEEBER-PLAN.md` Phase B1).

## Cart recovery, end to end

```mermaid
sequenceDiagram
    participant Shopify
    participant Weebersh as weebersh<br/>(OAuth bridge app, separate repo)
    participant Routes as integrations/shopify/routes.ts
    participant DB as scheduled_calls table
    participant Sched as voice/workflows/scheduler.ts<br/>(60s sweep)
    participant Compliance as @weeber/compliance<br/>(DNC + calling-window gate)
    participant Transport as voice/telephony-transport.ts
    participant Pipeline as voice/stream.ts<br/>(see voice-orchestration.md)

    Shopify->>Weebersh: checkout created/updated
    Weebersh->>Routes: POST /api/integrations/shopify/checkouts (webhook)
    Routes->>DB: insert scheduled_calls row<br/>(workflowName=shopify-cart-recovery,<br/>runAt=+45min, checkoutToken, metadata)

    Note over Shopify,Routes: if the shopper completes checkout before the call fires...
    Shopify->>Weebersh: order created
    Weebersh->>Routes: POST /api/integrations/shopify/orders/create
    Routes->>DB: cancel pending call — match by checkoutToken first,<br/>fall back to phone number

    loop every 60s
        Sched->>DB: SELECT WHERE status='pending' AND run_at <= now()
        Sched->>Compliance: DNC check + calling-window (IST 9am-9pm) gate
        alt gate passes
            Sched->>Transport: place outbound call
            Transport->>Pipeline: call connects, hands off to the voice pipeline
        else gate fails
            Sched->>DB: reschedule or mark skipped (never silently drop)
        end
    end

    Pipeline->>Routes: call ends — disposition captured
    Note over Routes,DB: if order placed within 7 days of the call,<br/>attribute recoveredOrderId/recoveredAmount to it
```

## COD confirmation — same shape, different exhaustion behavior

```mermaid
flowchart TD
    A["orders/create webhook<br/>(gateway = cash_on_delivery, or financial_status = pending)"] --> B["scheduled_calls row<br/>workflowName=shopify-cod-confirmation<br/>runAt = +30min, maxAttempts=3"]
    B --> C{Call outcome?}
    C -->|Confirmed| D["confirmCodOrder tool tags order<br/>cod-confirmed via weebersh"]
    C -->|Explicit decline| E["Cancel order immediately<br/>(fixed 2026-07-13 — used to wait<br/>3 retries before canceling)"]
    C -->|No answer / retry| F{Attempts exhausted?}
    F -->|No| G["Reschedule per org retry-cadence config<br/>(retry-config.ts, per-org override,<br/>capped 1-20 attempts)"]
    F -->|Yes, all attempts exhausted| H["onExhausted webhook -><br/>auto-cancel order via weebersh /orders/cancel"]
```

## Where the org boundary is enforced

Every route below `requireUserOrg` middleware (`app/routes.ts`) reads `orgId` exclusively from the
resolved session (`c.get("userOrgId")`) — never from a path param or request body. The Shopify webhook
routes resolve `orgId` from the install-time-stamped value weebersh is expected to carry through its
OAuth flow (`buildInstallUrl` → weebersh's `state` → echoed back on `/connected`); when it's missing, the
backend defensively reuses whatever org that shop was already linked to instead of minting an orphan org
— see `integrations/shopify/routes.ts`'s `resolvedOrgId` fallback logic and `WEEBER-PLAN.md`'s workstream
F for the still-open weebersh-side root cause.
