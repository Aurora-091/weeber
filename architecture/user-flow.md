# User Flow — two apps, two audiences

Two physically separate route trees, two auth models — not one app with role-based hiding (deliberate,
matches how the earlier Vocalist frontend did it too).

```mermaid
flowchart TB
    subgraph Admin["/dashboard/* — operator app"]
        direction TB
        A1["ADMIN_API_KEY or Supabase SSO<br/>(admin-key-gate.tsx)"] --> A2["Calls / Orgs / Users /<br/>Agents / Workflows / Billing<br/>/ Compliance / Flags / Support"]
        A2 --> A3["Sees every org, platform-wide"]
    end

    subgraph User["/app/* — customer/merchant app (Shopify & Insurance)"]
        direction TB
        U1["Supabase Auth<br/>(email+password, magic link)"] --> U2{First login?}
        U2 -->|Yes| U3["resolveOrCreateMembership<br/>bootstraps a new org<br/>(unique-per-user, race-safe)"]
        U2 -->|No| U4["Loads existing org"]
        U3 --> U5["/app home —<br/>setup-modal.tsx auto-opens<br/>(?welcome=1 or zero agents)"]
        U4 --> U6["/app home"]
        U5 --> U7["Setup modal:<br/>pick vertical (Shopify / Insurance) -><br/>connect platform/carrier -> configure first agent<br/>-> test mode / test call"]
        U6 --> U8["Full nav: Home / Agents / Workflows /<br/>Conversations / Analytics / Billing /<br/>Integrations / Settings"]
        U7 --> U8
    end
```

## Merchant onboarding detail (Shopify vertical)

```mermaid
sequenceDiagram
    participant Merchant
    participant App as /app (setup-modal.tsx)
    participant API as app/routes.ts
    participant Weebersh as weebersh (OAuth bridge)
    participant Shopify

    Merchant->>App: signs up (Supabase Auth)
    App->>API: GET /api/app/me
    API->>API: resolveOrCreateMembership (first login only)
    API-->>App: org bootstrapped, vertical=shopify (default)
    App->>Merchant: setup modal opens (checklist, N/6 steps)
    Merchant->>App: clicks "Connect Shopify"
    App->>Weebersh: redirect, org_id stamped into install URL
    Weebersh->>Shopify: OAuth authorize
    Shopify->>Weebersh: OAuth callback
    Weebersh->>API: POST /api/integrations/shopify/connected<br/>(org_id + shop)
    API->>API: shop_links row created, org flips to "connected"
    Merchant->>App: configures first agent (persona preset,<br/>voice, retry cadence — Advanced settings disclosure)
    Merchant->>App: live test call (Agent Preview drawer,<br/>full-duplex mic/speaker via voice/test-call-stream.ts)
    App->>Merchant: agent enabled — first real call fires<br/>on the next matching Shopify event
```

## Agent config page — full-window console (2026-07-13 redesign)

```mermaid
flowchart LR
    Shell["AppShell (fullBleed)"] --> Bar["Slim top bar:<br/>agent-switcher pill<br/>(always visible)"]
    Bar --> Form["Full-height scrollable form:<br/>Identity & Tone -> Voice & Sound -><br/>Advanced (tools/guardrails/retry cadence/<br/>provider+model) -> Preview drawer"]
    Form --> Save["PUT /api/app/agent-configs/:templateKey"]
    Form --> Preview["PreviewButton -> PreviewDrawer<br/>(text chat + live voice test call,<br/>same configOverride contract as Save)"]
```
