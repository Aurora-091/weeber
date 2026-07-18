---
adr: 14
title: "Reverted ADR-013: back to the quick-tunnel, named tunnel parked"
date: 2026-07-05
status: Superseded/Reverted
---

## ADR-014 — Reverted ADR-013: back to the quick-tunnel, named tunnel parked
**Date:** 2026-07-05

**Context:** ADR-013's plan assumed a plain CNAME on Vercel's DNS could point at a Cloudflare Tunnel. It
can't: `<tunnel-id>.cfargotunnel.com` only resolves inside Cloudflare's own proxy network, so the hostname
has to actually be *proxied by Cloudflare* (orange-cloud on), not just pointed at from an external DNS
provider. The fix would have been Cloudflare's Partial (CNAME) Setup — letting Cloudflare proxy one
subdomain while everything else stays on Vercel — but Cloudflare has since restricted that to
Enterprise/partner accounts; free-tier setup now requires migrating the zone's nameservers to Cloudflare
entirely (Vercel hosting would still work fine as DNS-only records after the move, but it's real migration
effort and propagation time).

**Decision:** Not worth it right now. The project is heading into a Reddit/community-feedback and
build-in-public phase, not a public launch depending on a stable domain — the free quick-tunnel's rotating
URLs are a non-issue at this stage since `tunnel-supervisor.sh` (ADR-008/ADR-011) already auto-updates
`PUBLIC_APP_URL` and the Twilio webhook on every rotation. Reverted: killed the `cloudflare-tunnel` PM2
process, restarted the quick-tunnel under the existing supervisor script, confirmed `/api/health` responds
`200` on the new quick-tunnel URL after a `pm2 restart web-app --update-env`.

**Consequences:** `scripts/run-cloudflare-tunnel.sh` and the Cloudflare tunnel/DNS config created in
ADR-013 are left in place (tunnel still exists, ingress still configured) in case nameserver migration
happens later — nothing to redo except re-adding the CNAME once DNS actually sits on Cloudflare. No code
changes this round, only infra/ops. Revisit named-tunnel setup once there's a real reason for a stable
public domain (real user traffic, a production launch) rather than doing it preemptively.

---
