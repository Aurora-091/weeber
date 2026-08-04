/**
 * DEV-ONLY structural preview harness.
 *
 * Mounts the REAL AppShell + REAL /app page components with a mock user
 * context and an isolated QueryClient (retry:false), so shell/page structure
 * — nav-intent prefetch, page containers, card primitives, z-index/overflow —
 * can be verified in a browser without a backend or Supabase secrets. Data
 * fetches fail fast to empty/error states, which is exactly enough to inspect
 * layout structure.
 *
 * This module is only ever reached from a route gated behind
 * `import.meta.env.DEV` (see app.tsx), so it is tree-shaken out of every
 * production build. Do not import it from production code.
 */
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/shell/app-shell";
import { UserContext, type UserContextValue } from "../components/app/user-shell";
// Shared with pages/__harness so the two harnesses cannot disagree about what
// the mock org contains.
import { makeHarnessClient, mockMe } from "./__harness/fixtures";
import { getVertical } from "../lib/verticals";
import { useShellFullBleed } from "../components/shell/app-shell";
import { UserHomePage } from "./app/home";
import { UserAgentsPage, ToolsGuardrailsTab } from "./app/agents";
import { CompiledPromptPanel, type PromptSegment } from "../components/agent-preview/CompiledPromptPanel";
import { toFormState, type AgentConfigRow, type FormState } from "../lib/agent-config";
import { UserIntegrationsPage } from "./app/integrations";
import { UserWorkflowsListPage } from "./app/workflows";
import { UserCallsPage } from "./app/calls";
import { UserSettingsPage } from "./app/settings";
import { UserKnowledgeBasePage } from "./app/knowledge-base";
// Admin pages mounted purely to verify the card-primitive sweep (fix #3) — they
// use no admin context (confirmed), just react-query hooks that fail fast to
// empty/skeleton states under the isolated retry:false client. Enough to check
// corner-radius + shadow parity of converted card-weeber frames vs skeletons.
import { CompliancePage } from "./dashboard/compliance";
import { TemplatesPage } from "./dashboard/templates";
import { FlagsPage } from "./dashboard/flags";

const previewClient = makeHarnessClient();


/** Synthetic full-bleed probe — verifies AppShell's full-bleed <main> variant
 * fills the viewport edge-to-edge with no overflow/scroll (same mechanism the
 * workflow canvas uses via useShellFullBleed()). */
function FullBleedProbe() {
  useShellFullBleed();
  return (
    <div className="page-enter flex h-full flex-col p-4 sm:p-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <span className="text-sm font-medium">Full-bleed header row</span>
        <span className="text-xs text-muted-foreground">no page padding / no doc scroll</span>
      </div>
      <div className="mt-4 flex flex-1 overflow-hidden rounded-lg">
        <div className="flex-1 rounded-lg bg-muted/40 ring-1 ring-inset ring-border grid place-items-center text-xs text-muted-foreground">
          canvas fills remaining height
        </div>
        <div className="ml-4 w-72 shrink-0 rounded-lg border border-border p-4 text-xs text-muted-foreground">
          side panel
        </div>
      </div>
    </div>
  );
}

/**
 * Phase III (ADR-067) probe — the agent editor's Tools & guardrails tab and the
 * compiled-prompt panel, both mounted with local state so their real pixels can
 * be inspected without a backend. The real /app/agents page needs a loaded org
 * and agent row, so under this harness's retry:false client it only ever
 * renders an empty state, which verifies nothing about D2/D3/D4.
 *
 * The segments below are deliberately SHORT SYNTHETIC PLACEHOLDERS, not copies
 * of real prompt text. Real text lives in exactly one place (the backend's
 * composeSystemPrompt, join-invariant unit-tested) and duplicating it here
 * would create the second, drifting source ADR-067 exists to prevent. This
 * probe answers layout questions only: do the layers collapse, does the
 * merchant's own layer read as theirs, does the diff appear on a tool toggle,
 * do the tool groups and guardrail consequence sentences fit.
 */
const PROBE_ROW: AgentConfigRow = {
  templateKey: "shopify-cart-recovery",
  templateName: "Cart recovery",
  templateDescription: "Calls customers who left a cart behind.",
  defaultPersonaPrompt: "You help customers of the store with abandoned carts.",
  config: null,
};

function probeSegments(form: FormState): PromptSegment[] {
  const toolCount = form.toolsEnabled.length;
  return [
    {
      id: "language",
      label: "Language behaviour",
      source: "Added automatically from the agent's Language setting.",
      body: form.language && form.language !== "en" ? `[layout probe] language instruction for "${form.language}".\n\n` : "",
      editable: false,
    },
    {
      id: "identity",
      label: "Identity & tone",
      source: "Built from the agent's name, business name, tone, greeting and closing line.",
      body: `[layout probe] Your name is ${form.name || "—"}.\n[layout probe] Tone: ${form.toneStyle || "—"}.\n\n`,
      editable: false,
    },
    {
      id: "persona",
      label: "Your instructions",
      source: "The prompt you wrote — the only layer you edit directly.",
      body: form.personaPrompt || PROBE_ROW.defaultPersonaPrompt || "",
      editable: true,
    },
    {
      id: "disclosure",
      label: "Recording disclosure",
      source: "Compliance requirement — spoken at the very start of every call.",
      body: "\n\n[layout probe] Recording + AI disclosure line goes here.",
      editable: false,
    },
    {
      id: "call-control",
      label: "Call control & guardrails",
      source: "Generated from the tools and guardrail settings on this page.",
      body:
        `\n\n[layout probe] Call control — ${toolCount} tool(s) enabled.\n` +
        form.toolsEnabled.map((t) => `- instruction line for ${t}`).join("\n") +
        `\n- topic boundary: ${form.topicBoundaryStrictness}` +
        `\n- injection: ${form.injectionSensitivity}` +
        `\n- abuse handling: ${form.abuseHandlingEnabled ? "on" : "off"}`,
      editable: false,
    },
  ];
}

function PhaseIIIProbe() {
  const [form, setForm] = useState<FormState>(() => toFormState(PROBE_ROW));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const configKey = JSON.stringify(form);
  const fetchFn = () => {
    const segments = probeSegments(form);
    return Promise.resolve(
      new Response(JSON.stringify({ text: segments.map((s) => s.body).join(""), segments }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return (
    <div className="page-enter grid gap-6 p-4 sm:p-6 lg:grid-cols-2">
      <div className="card-weeber card-weeber--editor p-5">
        <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">
          D3 + D4 · Tools &amp; guardrails tab
        </p>
        <ToolsGuardrailsTab row={PROBE_ROW} form={form} set={set} />
      </div>
      <div className="card-weeber flex max-h-[80vh] flex-col overflow-hidden p-5">
        <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">
          D2 · Compiled prompt panel (synthetic segments)
        </p>
        <div className="flex min-h-0 flex-1 flex-col">
          <CompiledPromptPanel fetchFn={fetchFn} configKey={configKey} />
        </div>
      </div>
    </div>
  );
}

/** Agents overview grid (2026-08-01) with seeded data.
 *
 * The plain `agents` entry below renders the same component against no
 * backend, which only ever shows the error state. This seeds the two queries
 * the page reads so the actual grid — and each readiness state — is visible:
 * one live agent, one live-but-unnumbered, one paused, one never-saved. */
function AgentsGridProbe() {
  useState(() => {
    const mk = (
      templateKey: string,
      templateName: string,
      templateDescription: string,
      config: AgentConfigRow["config"],
    ): AgentConfigRow => ({
      templateKey,
      templateName,
      templateDescription,
      defaultPersonaPrompt: "Seeded persona body.",
      config,
    });
    const base = {
      name: null, greetingLine: null, closingLine: null, toneStyle: null, personaPrompt: null,
      voiceProvider: null, voiceId: null, language: null, sttProvider: null, llmProvider: null,
      llmModel: null, sttFallbackOrder: null, ttsFallbackOrder: null, llmFallbackModels: null,
      toolsEnabled: null, guardrails: null, enabled: true,
      firstCallDelayMinutes: null, retryDelayMinutes: null, maxAttempts: null, phoneNumberId: null,
    } satisfies NonNullable<AgentConfigRow["config"]>;

    previewClient.setQueryData(["app-agent-configs"], {
      agentConfigs: [
        mk("shopify-cart-recovery", "Cart recovery", "Calls customers who left a cart behind and offers to help them finish.", {
          ...base, phoneNumberId: 1, toolsEnabled: ["offerCartRecoveryDiscount", "captureField", "setDisposition"],
          language: "en-IN", personaPrompt: "A persona the merchant has edited.",
        }),
        mk("shopify-cod-confirmation", "COD confirmation", "Confirms cash-on-delivery orders before they ship to cut RTO.", {
          ...base, phoneNumberId: null, toolsEnabled: ["confirmCodOrder", "setDisposition"], language: "hi-IN",
        }),
        mk("shopify-order-status", "Order status", "Answers inbound 'where is my order' calls using your store data.", {
          ...base, enabled: false, phoneNumberId: 1,
        }),
        mk("shopify-winback", "Win-back", "Reaches lapsed customers with a reason to come back.", null),
      ] satisfies AgentConfigRow[],
    });
    // No org-level outbound number → the unnumbered agent must show a warning.
    previewClient.setQueryData(["app-telephony-status"], { telephony: { outboundNumber: null } });
    return true;
  });
  return <UserAgentsPage />;
}

const PAGES = {
  home: { label: "Home", Comp: UserHomePage },
  agentsgrid: { label: "Agents grid", Comp: AgentsGridProbe },
  phase3: { label: "Phase III probe", Comp: PhaseIIIProbe },
  fullbleed: { label: "Full-bleed probe", Comp: FullBleedProbe },
  agents: { label: "Agents", Comp: UserAgentsPage },
  workflows: { label: "Workflows (full-bleed)", Comp: UserWorkflowsListPage },
  calls: { label: "Conversations", Comp: UserCallsPage },
  integrations: { label: "Integrations", Comp: UserIntegrationsPage },
  kb: { label: "Knowledge base", Comp: UserKnowledgeBasePage },
  settings: { label: "Settings", Comp: UserSettingsPage },
  compliance: { label: "Admin · Compliance", Comp: CompliancePage },
  templates: { label: "Admin · Templates", Comp: TemplatesPage },
  flags: { label: "Admin · Flags", Comp: FlagsPage },
} as const;

type PageKey = keyof typeof PAGES;

export function PreviewHarness() {
  const [page, setPage] = useState<PageKey>("agentsgrid");
  const vertical = getVertical("shopify");
  const ctx: UserContextValue = {
    me: mockMe,
    vertical,
    flags: {},
    isFlagEnabled: () => false,
  };
  const { Comp } = PAGES[page];

  return (
    <QueryClientProvider client={previewClient}>
      <UserContext.Provider value={ctx}>
        {/* Floating page picker — outside the shell, above everything. */}
        <div className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-full border border-neutral-300 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
          <div className="flex items-center gap-1">
            <span className="px-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              preview
            </span>
            {(Object.keys(PAGES) as PageKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setPage(key)}
                className={
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
                  (page === key
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100")
                }
              >
                {PAGES[key].label}
              </button>
            ))}
          </div>
        </div>
        <AppShell
          density="spacious"
          collapsible
          nav={vertical.nav}
          brand={<span className="font-display text-base font-semibold tracking-tight">Weeber</span>}
        >
          <Comp />
        </AppShell>
      </UserContext.Provider>
    </QueryClientProvider>
  );
}

export default PreviewHarness;
