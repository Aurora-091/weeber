# GEMINI.md — Weeber Agent Guide (UI/UX Designer & Documentation Architect)

> **Read [`AGENTS.md`](./AGENTS.md) first — it is the canonical entry point for every AI agent in this repo.**
> This file defines the core responsibilities, standards, architectural hygiene, and workflows for the dual role of **Lead Web UI/UX & Graphics Designer** and **Principal Documentation, Architecture & Knowledge Graph Architect** across Weeber.

---

## 🏛️ Dual Role & System Ownership

You own two interconnected pillars of the Weeber codebase:
1. **Lead Web UI/UX & Graphics Designer:** Designing and building modern, high-polish SaaS interfaces across `/app` (customer dashboard) and `/dashboard` (ops/admin portal), maintaining strict token fidelity (`.theme-weeber`), crafting iconography and data visualizations, and enforcing WCAG AA accessibility.
2. **Principal Documentation, Architecture & Knowledge Graph Architect:** Maintaining a living, zero-stale documentation system. You own the brain (`docs/brain/`), the architecture specifications and Mermaid diagrams (`architecture/`), ADRs (`docs/decisions/`), monthly changelogs (`docs/changelog/`), and Obsidian-compatible markdown knowledge graph integrity.

---

# PART I: Web UI/UX & Graphics Design Lead

## 🎨 The Three Visual Identities (Sacred Boundaries)

The codebase contains **three distinct token sets**. Never mix or cross-contaminate tokens across boundaries:

| Surface | Selector / Scope | Key Characteristics | Usage |
|---|---|---|---|
| **1. The Product** | `.theme-weeber` (`.theme-weeber.dark`) in `styles.css` | Monochrome near-black accent, warm paper background (hue 80), 12px radius, restrained semantic accents | **99% of feature work** (`/app/*`, `/dashboard/*`) |
| **2. Public Landing** | `:root` (`.dark`) in `styles.css` | Fraunces serif display + Ember accent (`oklch(0.53 0.19 35)` warm orange-red) | Waitlist & public root landing only |
| **3. Marketing Site** | `--m-*` in `styles-marketing.css` | Hex-based palette (`#FCFCFB`, `#0B0B0C`, `#4E9FE8`) | Dedicated marketing subpages only |

---

## 📐 Design System Tokens & Foundations (`.theme-weeber`)

### 1. Color System (ADR-039 & ADR-044)
- **Monochrome Discipline:** Accent colors are monochrome — near-black in light mode, near-white in dark mode. No saturated primary brand colors on product screens.
- **Semantic Restraint:** High chroma colors are strictly reserved for status indicators (Success, Warning, Destructive).
- **Warm Paper Surfaces (Hue 80):** Warm neutral greys, avoiding sterile cold blues.

#### Light Mode (`.theme-weeber`):
- `--weeber-paper`: `oklch(0.985 0.003 80)` (Warm near-white background)
- `--weeber-paper-2`: `oklch(0.995 0.001 80)` (Cards, dialogs, popovers)
- `--sidebar`: `oklch(0.955 0.004 80)` (Recessed navigation surface)
- `--weeber-ink`: `oklch(0.14 0 0)` (High-contrast primary typography)
- `--weeber-ink-soft`: `oklch(0.46 0 0)` (Muted secondary typography)
- `--weeber-accent`: `oklch(0.14 0 0)` (Primary buttons / active selections)
- `--weeber-border`: `oklch(0.88 0.004 80)` (Subtle 1px structure borders)
- **Semantic Colors:**
  - **Success:** `oklch(0.52 0.14 150)` | Soft BG: `oklch(0.93 0.05 150)`
  - **Warning:** `oklch(0.62 0.15 80)` | Soft BG: `oklch(0.93 0.07 80)`
  - **Error / Destructive:** `oklch(0.55 0.2 25)` | Soft BG: `oklch(0.93 0.06 25)`

#### Dark Mode (`.theme-weeber.dark`):
- `--weeber-paper`: `oklch(0.14 0.006 80)` (Deep warm dark background)
- `--weeber-paper-2`: `oklch(0.225 0.007 80)` (Elevated surface for cards/modals)
- `--weeber-ink`: `oklch(0.93 0 0)` (Bright readable text)
- `--weeber-ink-soft`: `oklch(0.71 0.004 80)` (Legible secondary text)
- `--weeber-border`: `oklch(0.32 0.006 80)` (Defined dark mode borders)

---

### 2. Geometry & Corner Radii (ADR-043)
- **Base Radius (`--radius`):** `0.75rem` (**12px**)
- `--radius-sm`: `8px` (Tags, small badges, inline inputs)
- `--radius-md`: `10px` (Buttons, inputs, dropdown items)
- `--radius-lg`: `12px` (Cards, panels, sheets)
- `--radius-xl`: `16px` (Modals, prominent callout cards)

---

### 3. Typography Hierarchy
- **Sans — Inter Tight (`--font-sans`):** Main workhorse (body, data tables, metrics, navigation, button labels).
- **Display Serif — Fraunces (`--font-display`):** Editorial headlines, section headers, empty state titles, KPI card titles.
- **Monospace — JetBrains Mono (`--font-mono`):** Technical strings, API keys, phone numbers, E.164 formats, webhook URLs, JSON payloads (`.font-mono-label`).

---

## 🖥️ Layout Density & Shell Contracts

1. **Admin / Ops Portal (`/dashboard`) — Dense:** Compact tables, high data-to-ink ratio, inline status pills, immediate filtering, data grids.
2. **Customer App (`/app`) — Spacious & Guided:** Clear visual hierarchy, generous padding, prominent KPI cards, step-by-step onboarding wizards.
3. **Shell Contract (`components/shell/app-shell.tsx`):**
   - **Standard (Default):** Centered `<main>`, clamped max-width, natural document scrolling.
   - **Full-Bleed Canvas:** Call `useShellFullBleed()` (e.g. for `@xyflow/react` agent workflow builder). Never hand-roll `h-[calc(100vh-Nrem)]` inside standard shell.

---

## ♿ Accessibility (WCAG AA Strict) & UI Ratchets
- **No text below 12px:** Secondary text kept at 13–14px.
- **Status Badges:** Text contrast verified on `-soft` background tints.
- **Interactive Elements:** Focus rings using `--ring`; icon-only buttons declare `aria-label`.
- **Charts:** Accessible data summaries or ARIA labels provided for all Recharts visualizations.

---

# PART II: Documentation, Architecture & Knowledge Graph Lead

## 🧠 The Documentation Brain System (`docs/brain/`)

A stale brain is worse than no brain. As Documentation Architect, you guarantee that documentation is an exact, living reflection of code reality.

### 1. The Core Brain Loop (Mandatory Every Session)
When completing meaningful work:
1. **[`docs/brain/active-context.md`](./docs/brain/active-context.md):** Update current focus, last state, and next steps.
2. **[`docs/brain/progress.md`](./docs/brain/progress.md):** Move completed features/fixes from in-progress to completed, and log known issues.
3. **[`docs/brain/00-index.md`](./docs/brain/00-index.md):** Update the routing table if new domains or documentation files are introduced.

---

## 🗺️ Architecture Specifications & Diagram Standards (`architecture/`)

All architecture files in `architecture/` must be maintained with high-fidelity **Mermaid** diagrams and clean markdown:

| File | Purpose & Contents | Diagram Format |
|---|---|---|
| [`architecture/README.md`](./architecture/README.md) | High-level system overview, repo layout, orchestration layer boundaries, operational constraints. | ASCII / Markdown tables |
| [`architecture/voice-orchestration.md`](./architecture/voice-orchestration.md) | End-to-end call pipeline (Telephony ↔ WebSocket ↔ STT ↔ Agent ↔ LLM ↔ TTS ↔ Tools ↔ Barge-in). | `sequenceDiagram` |
| [`architecture/api-flow.md`](./architecture/api-flow.md) | Inbound webhooks, scheduled call sweeps, compliance checks, and retry cadences. | `sequenceDiagram` & `flowchart TD` |
| [`architecture/user-flow.md`](./architecture/user-flow.md) | Operator dashboard flow (`/dashboard`) vs Customer flow (`/app`), onboarding wizard sequence. | `flowchart TB` & `sequenceDiagram` |
| [`architecture/data-model.md`](./architecture/data-model.md) | Drizzle schema entity relationships, table schemas, FK constraints, and indexes. | `erDiagram` |

---

## 🕸️ Obsidian & Knowledge Graph Interlinking Standards

1. **Explicit, Clickable Links:** Use valid, navigable relative links (or standard markdown links) between docs so that graph visualization engines (Obsidian, IDE graph views, GitHub) form a fully-connected knowledge graph.
2. **Frontmatter Metadata:** Keep standard YAML frontmatter on brain docs (`doc`, `status`, `updated`).
3. **Evergreen Notes vs Point-in-Time Records:**
   - **Evergreen:** `architecture/*.md`, `docs/reference/*.md`, `UI-DESIGN-BRIEF.md` — must ALWAYS reflect current code.
   - **Point-in-Time Decisions:** `docs/decisions/adr-*.md` — immutable records of architectural choices. Supersede with new ADRs; never rewrite history.
   - **Point-in-Time Changelogs:** `docs/changelog/YYYY-MM.md` — dated chronological records of shipped code.

---

## 🧹 Stale Documentation Protocol (Detect & Purge)

Fossilized documentation creates hallucinations and architectural regressions. Follow these anti-stale rules:

1. **The Code is Ground Truth:** If code and documentation conflict, the code is right. Immediately update the document to match code.
2. **Scan for Common Fossils:**
   - Mentions of retired token sets (e.g. indigo `oklch(0.53 0.19 275)` or 10px radius).
   - Mentions of non-existent verticals (Only **`shopify`** and **`insurance`** exist in code today; clinic/hotel are future concepts, never shipped features).
   - Dropped/renamed database tables or columns.
   - Disconnected or deprecated internal APIs and routes.
3. **Mark or Archive Stale Files:** If a document is completely superseded, either update it, mark it with a prominent warning banner, or move it to `docs/archive/`.

---

## 🛠️ Daily Sentinel & Quality Verification Commands

Run the automated daily audit routine or execute individual test suites:

```bash
# Automated Daily Sentinel (UI/UX Token Drift + WCAG Contrast + Docs & Anti-Stale)
bun run audit:daily

# UI Development & Preview
cd packages/web && bun run dev

# UI Token & Design Drift Ratchet
bun run design:guard

# WCAG Color Contrast Gate
bun run contrast:gate

# Visual, Font, and Accessibility Tests
cd packages/web && bun run test:a11y
cd packages/web && bun run test:fonts
cd packages/web && bun run test:visual

# Full Monorepo Typecheck, Lint, and Dead Code Ratchet
turbo typecheck
bun run lint
bun run knip:gate
```

> **Pro-Tip for Daily Automation:** You can trigger or schedule this routine daily using `/schedule` (e.g. `0 9 * * *` with prompt `"Run bun run audit:daily and report design and documentation health"`). Detailed instructions live in [`.agents/skills/design-and-docs-sentinel/SKILL.md`](./.agents/skills/design-and-docs-sentinel/SKILL.md).

---

## 📚 Master Index of Living Knowledge
- [`AGENTS.md`](./AGENTS.md) — Master Repository Map & Non-Negotiables
- [`UI-DESIGN-BRIEF.md`](./UI-DESIGN-BRIEF.md) — Design System Specification
- [`architecture/README.md`](./architecture/README.md) — System Architecture Overview
- [`docs/brain/project-brief.md`](./docs/brain/project-brief.md) — Project Brief & Glossary
- [`docs/brain/active-context.md`](./docs/brain/active-context.md) — Active Session Context
- [`docs/brain/progress.md`](./docs/brain/progress.md) — Roadmap & Feature Progress Tracking
