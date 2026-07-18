---
adr: 13
title: "Named Cloudflare tunnel replaces the quick-tunnel supervisor"
date: 2026-07-05
status: Accepted
---

## ADR-013 — Named Cloudflare tunnel replaces the quick-tunnel supervisor
**Date:** 2026-07-05

**Context:** ADR-008 documented the free `trycloudflare.com` quick-tunnel's core problem: it assigns a new
random URL on every restart, so `PUBLIC_APP_URL` and the Twilio Voice webhook drift out of sync whenever
the tunnel drops. ADR-011's `tunnel-supervisor.sh` mitigated the pain (auto-restart + auto-update the
webhook on URL change) but explicitly said the real fix was a named tunnel or a persistent real domain.
The user now has a Cloudflare account and a domain (DNS managed on Vercel, not moved to Cloudflare).

**Decision:** Create a real named Cloudflare Tunnel via the Cloudflare API rather than the quick-tunnel:
- `POST /accounts/:id/cfd_tunnel` creates a persistent tunnel with a fixed ID; ingress config routes
  `vent.<domain>` → `http://localhost:4200` via `PUT /accounts/:id/cfd_tunnel/:id/configurations`.
- DNS stays on Vercel — a tunnel only needs a CNAME pointing at `<tunnel-id>.cfargotunnel.com`; moving the
  zone to Cloudflare was never required. This CNAME is added manually in Vercel's panel (not automatable
  without Vercel API credentials, which weren't requested).
- The tunnel token is stored in `.cloudflare-tunnel-token` (repo-root, gitignored, never committed) rather
  than passed inline on the command line, to avoid it ending up in shell history or a tmux pane buffer.
- Run via `scripts/run-cloudflare-tunnel.sh`, managed by PM2 (`cloudflare-tunnel` process) alongside
  `web-app` — consistent with how the main server is already supervised, and gives automatic restart on
  crash without a separate bash-loop supervisor.
- `tunnel-supervisor.sh` (ADR-011) is kept in the repo but marked superseded — still useful as a fallback
  for local dev without a domain, but no longer what's actually running.
- `PUBLIC_APP_URL` and the Twilio number's Voice webhook were both updated to the new fixed hostname; no
  more rotation, so no auto-update logic is needed for this path (unlike the quick-tunnel's URL-on-every-
  restart problem).

**Consequences:** This closes the last open item from ADR-011's hardening round. The tunnel has a fixed
hostname now, so call quality/webhook delivery no longer depends on catching a URL-rotation event in time.
Tradeoff: standing up this tunnel required real Cloudflare account credentials (API token, account ID) —
fine for this project since the user has them, but means the setup isn't zero-account like the quick-tunnel
was; documented in README as an optional-but-recommended step for anyone self-hosting Vent long-term.
