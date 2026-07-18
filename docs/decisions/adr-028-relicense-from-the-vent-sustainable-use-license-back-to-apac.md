---
adr: 28
title: "Relicense from the Vent Sustainable Use License back to Apache 2.0, protect the name via trademark instead"
date: 2026-07-09
status: Accepted
---

## ADR-028 — Relicense from the Vent Sustainable Use License back to Apache 2.0, protect the name via trademark instead

**Date:** 2026-07-09

**Context:** ADR-018 moved the project from MIT to a fair-code license (Vent/OpenVent Sustainable Use
License) specifically to prevent a cloud provider from hosting the software as a competing managed service
ahead of a future "OpenVent Cloud" paid layer. Since then, the actual near-term priority shifted: the goal
now is making OpenVent genuinely open for outside contribution — real PRs, real community trust, potential
inclusion in ecosystem listings and integrations. A source-available, non-OSI license works against that
goal in practice: it's unfamiliar to most contributors, triggers legal-review friction at companies that
might otherwise adopt or contribute, and signals "the maintainer can restrict this later" even though no
restriction was planned beyond the anti-resale clause. Apache 2.0 is OSI-approved, includes an explicit
patent grant (relevant here — telephony/codec-adjacent code carries more patent surface than typical web
app code), and is the standard choice for infrastructure projects that want real external contribution
(Kubernetes, most CNCF projects) as opposed to projects optimizing to prevent cloud-vendor resale at the
cost of community growth (n8n's actual tradeoff, made deliberately for their situation). At zero external
contributors and zero known forks today — the same condition that made ADR-018 cheap to make — this
reversal is equally cheap: no CLA, no consent needed, one commit.

The anti-competing-hosted-service goal from ADR-018 doesn't fully disappear; it's just solved with a
different mechanism. A permissive code license doesn't protect the *code* from being repackaged, but it was
never really the code that mattered for that concern — it's the name. Someone can already fork any Apache
2.0 project and run it as a service; what they can't do is call it "OpenVent" or use the OpenVent logo while
doing it, without that being a trademark violation. This is the same split Kubernetes, Docker, and (for
their core) Supabase actually rely on: permissive code + trademark control on the brand, not a custom
license restricting the code itself.

**Decision:**
- Replace `LICENSE` with the unmodified, canonical Apache License 2.0 text.
- Add a `NOTICE` file with the copyright line and a pointer to the trademark policy (standard Apache 2.0
  practice for projects that also want to flag trademark terms).
- Add `TRADEMARK.md` — plain-language policy: forking, self-hosting, and even commercial use of the code is
  fully permitted; naming a fork/hosted-service/product "OpenVent" (or confusingly similar) or using the
  logo in a way that implies official status is not, without permission.
- Update `packages/openvent-compliance/package.json`'s `license` field from `"SEE LICENSE IN ../../LICENSE"`
  to `"Apache-2.0"`.
- Update `README.md`'s License section to describe Apache 2.0 + the trademark carve-out, replacing the
  fair-code description.
- Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private vulnerability reporting via
  GitHub Security Advisories) — didn't exist before; table stakes for a project actually asking for outside
  contribution.
- Add `.github/ISSUE_TEMPLATE/` (bug report, feature request, config linking to Discussions) and
  `.github/PULL_REQUEST_TEMPLATE.md` — checklist mirrors the existing expectations already documented in
  `CONTRIBUTING.md` (tests, typecheck, docs-in-same-PR, ADR entries for real decisions) so they're enforced
  at the PR template level, not just prose.
- Add a "Good places to start" section to `CONTRIBUTING.md` and an "Open for contribution" section to
  `ROADMAP.md` listing concrete, scoped items (telephony abstraction, scoped required-field schemas, more
  integrations, local mock mode, docs gaps) that are wanted but not on the maintainer's active queue.

**Consequences:** All code contributed from this commit forward is Apache 2.0 — permissive, commercially
usable by anyone, including as a competing hosted service, which ADR-018 explicitly tried to prevent. That
tradeoff is accepted deliberately: the trademark policy is the actual mechanism protecting the "OpenVent"
name and brand equity now, not the code license. If a genuine premium/hosted layer gets built later (the
"OpenVent Cloud" from ADR-015), it can live as closed-source code calling the open core, or under a
separate license for just that layer — it does not require the core to be non-permissive. No functional
code changes in this round. Anyone relying on the code under the Sustainable Use License terms as it stood
before this commit keeps no different rights either way, since Apache 2.0 grants strictly more.
