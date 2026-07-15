import { Rocket, Bot, PhoneCall, CreditCard, Plug, Settings, GitBranch, BookOpen, Phone, ShoppingBag, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NavItem } from "../components/shell/app-shell";
import { appPath } from "./route-base";

/**
 * Vertical-driven user UI (USER-APP-PAGE-MAP §4, ADR-031's seam
 * carried into the frontend): nav, labels, copy, AND dashboard content are
 * data per vertical, not JSX branches. Shopify is the only vertical with
 * real agents today; a clinic/hotel vertical adds an entry here (+
 * agentTemplates rows on the backend) — no shared-component changes.
 *
 * `dashboard` mirrors Vocalist's per-vertical `dashboard.metrics` /
 * `dashboard.cards` config (see docs/DECISIONS.md "Setup modal, not a setup
 * page") — the Home page (pages/app/analytics.tsx) renders these instead of
 * hardcoding Shopify-shaped stat cards.
 */
export type VerticalDefinition = {
  key: string;
  /** What this vertical calls the humans being called. */
  glossary: {
    customer: string;
    customers: string;
  };
  /** Display name of the connected platform (nav label, connection page title). */
  integrationLabel: string;
  /** Whether this vertical has a real, live OAuth/API integration to connect
   * (Shopify does; a future clinic/insurance-system connector doesn't exist
   * yet — see integrations.tsx's own vertical-gating comment). Drives
   * whether the onboarding modal's "Connect store" step renders at all —
   * added 2026-07-16, previously that step was unconditionally Shopify-
   * shaped regardless of which vertical was picked. */
  hasLiveIntegration: boolean;
  nav: NavItem[];
  copy: {
    callsEmptyTitle: string;
    callsEmptyBody: string;
    analyticsEmptyBody: string;
    onboardingConnectTitle: string;
    onboardingConnectBody: string;
  };
  /** Config-driven Home page content — add a vertical by filling this in, not by branching analytics.tsx. */
  dashboard: {
    /** Extra metric tiles alongside the universal call stats (calls, latency, tool errors). */
    metrics: { key: string; label: string; hint?: string }[];
    emptyState: { title: string; body: string };
  };
};

// Nav label for the platform-connection page used to be the vertical's own
// integrationLabel ("Shopify"), so the nav and page title matched exactly
// what platform was connected. Changed 2026-07-16 (explicit user decision):
// generic "Integrations" everywhere in the nav/page-title chrome instead —
// `integrationLabel` itself is unchanged and still used for *prose* that
// needs the actual platform name ("your Shopify store", agents.tsx's empty
// state) where "your Integrations store" wouldn't read as a real sentence.
export const INTEGRATIONS_NAV_LABEL = "Integrations";

const SHOPIFY_INTEGRATION_LABEL = "Shopify";

function navMatch(subpath: string, tail: string): RegExp {
  const base = appPath(subpath);
  return new RegExp("^" + base + tail + "$");
}

const shopify: VerticalDefinition = {
  key: "shopify",
  glossary: { customer: "Customer", customers: "Customers" },
  integrationLabel: SHOPIFY_INTEGRATION_LABEL,
  hasLiveIntegration: true,
  nav: [
    { href: appPath(), label: "Home", icon: Rocket, match: navMatch("", "") },
    { href: appPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", "") },
    { href: appPath("/workflows"), label: "Workflows", icon: GitBranch, match: navMatch("/workflows", "(/.*)?") },
    { href: appPath("/calls"), label: "Conversations", icon: PhoneCall, match: navMatch("/calls", "(/.*)?") },
    { href: appPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", "") },
    { href: appPath("/integrations"), label: INTEGRATIONS_NAV_LABEL, icon: Plug, match: navMatch("/integrations", "") },
    { href: appPath("/knowledge-base"), label: "Knowledge Base", icon: BookOpen, match: navMatch("/knowledge-base", "") },
    { href: appPath("/numbers"), label: "Phone Numbers", icon: Phone, match: navMatch("/numbers", "") },
    { href: appPath("/settings"), label: "Settings", icon: Settings, match: navMatch("/settings", "") },
  ],
  copy: {
    callsEmptyTitle: "No conversations yet",
    callsEmptyBody:
      "Calls appear here once one of your agents makes its first call — for example after an abandoned checkout.",
    analyticsEmptyBody: "Numbers show up here after your agents have made their first calls.",
    onboardingConnectTitle: "Connect your Shopify store",
    onboardingConnectBody:
      "Install the Weeber app on your store so your agents can react to checkouts, orders, and fulfillments.",
  },
  dashboard: {
    // Funnel order: abandoned -> recovered -> rate -> revenue -> avg order
    // value. Backend already computes all five (org-queries.ts's
    // computeKpis) — cartsAbandoned/recoveryRate/avgOrderValue were sitting
    // unused on the wire until 2026-07-16, this page just never read them.
    metrics: [
      { key: "carts_abandoned", label: "Carts abandoned", hint: "Abandoned checkouts detected" },
      { key: "carts_recovered", label: "Carts recovered", hint: "Checkouts an agent brought back" },
      { key: "recovery_rate", label: "Recovery rate", hint: "Recovered / attempted calls" },
      { key: "revenue_recovered", label: "Revenue recovered" },
      { key: "avg_order_value", label: "Avg order value", hint: "Per recovered order" },
      { key: "calls_per_day", label: "Calls per day", hint: "Average over the selected range" },
    ],
    emptyState: {
      title: "Set up your first agent",
      body: "Connect your store and turn on an agent to start recovering carts and handling order support automatically.",
    },
  },
};

// Insurance: no live CRM/policy-system OAuth integration exists yet (unlike Shopify's weebersh
// flow) -- deliberately no "Integrations" nav entry, since pages/app/integrations.tsx is entirely
// Shopify-hardcoded today and would show a broken/irrelevant page for this vertical. Add one once
// a real policy-system connector exists, matching how Shopify's got built.
const insurance: VerticalDefinition = {
  key: "insurance",
  glossary: { customer: "Policyholder", customers: "Policyholders" },
  integrationLabel: "Policy System",
  hasLiveIntegration: false,
  nav: [
    { href: appPath(), label: "Home", icon: Rocket, match: navMatch("", "") },
    { href: appPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", "") },
    { href: appPath("/workflows"), label: "Workflows", icon: GitBranch, match: navMatch("/workflows", "(/.*)?") },
    { href: appPath("/calls"), label: "Conversations", icon: PhoneCall, match: navMatch("/calls", "(/.*)?") },
    { href: appPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", "") },
    { href: appPath("/knowledge-base"), label: "Knowledge Base", icon: BookOpen, match: navMatch("/knowledge-base", "") },
    { href: appPath("/numbers"), label: "Phone Numbers", icon: Phone, match: navMatch("/numbers", "") },
    { href: appPath("/settings"), label: "Settings", icon: Settings, match: navMatch("/settings", "") },
  ],
  copy: {
    callsEmptyTitle: "No conversations yet",
    callsEmptyBody:
      "Calls appear here once one of your agents makes its first call — for example a renewal reminder or a lead follow-up.",
    analyticsEmptyBody: "Numbers show up here after your agents have made their first calls.",
    onboardingConnectTitle: "Set up your first agent",
    onboardingConnectBody:
      "Turn on the Policy Renewal Reminder or Lead Follow-Up agent to start reaching policyholders and leads automatically.",
  },
  dashboard: {
    metrics: [
      { key: "renewals_confirmed", label: "Renewals confirmed", hint: "Policyholders who confirmed on a reminder call" },
      { key: "leads_qualified", label: "Leads qualified", hint: "Leads booked with a licensed advisor" },
    ],
    emptyState: {
      title: "Set up your first agent",
      body: "Turn on an agent to start reminding policyholders and following up on leads automatically.",
    },
  },
};

const VERTICALS: Record<string, VerticalDefinition> = { shopify, insurance };

export function getVertical(key: string | null | undefined): VerticalDefinition {
  return VERTICALS[key ?? "shopify"] ?? shopify;
}

/** Picker options for "what kind of business is this" — the onboarding
 * modal's first step and Settings' Business type selector (2026-07-16).
 * Short, plain-English labels/descriptions, not the internal vertical key. */
export const VERTICAL_OPTIONS: { key: string; label: string; description: string; icon: LucideIcon }[] = [
  {
    key: "shopify",
    label: "Ecommerce (Shopify)",
    description: "Recover abandoned carts, confirm COD orders, and handle order-status calls automatically.",
    icon: ShoppingBag,
  },
  {
    key: "insurance",
    label: "Insurance",
    description: "Remind policyholders about renewals and follow up on leads for a licensed advisor.",
    icon: ShieldCheck,
  },
];

