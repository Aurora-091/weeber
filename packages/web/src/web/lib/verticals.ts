import { Rocket, Bot, PhoneCall, ChartBar as BarChart3, CreditCard, Plug, Settings } from "lucide-react";
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

// Nav label for the platform-connection page is the vertical's own
// integrationLabel ("Shopify" here, "EHR"/"PMS" for a future clinic
// vertical, etc.) — not a hardcoded "Integrations" — so the nav stays
// vertical-driven per USER-APP-PAGE-MAP §4 instead of a generic label
// that means something different per vertical. See verticals.test.ts's
// "contains all required nav items for shopify" test, which checks for
// this exact label.
const SHOPIFY_INTEGRATION_LABEL = "Shopify";

function navMatch(subpath: string, tail: string): RegExp {
  const base = appPath(subpath);
  return new RegExp("^" + base + tail + "$");
}

const shopify: VerticalDefinition = {
  key: "shopify",
  glossary: { customer: "Customer", customers: "Customers" },
  integrationLabel: SHOPIFY_INTEGRATION_LABEL,
  nav: [
    { href: appPath(), label: "Home", icon: Rocket, match: navMatch("", "") },
    { href: appPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", "") },
    { href: appPath("/calls"), label: "Conversations", icon: PhoneCall, match: navMatch("/calls", "(/.*)?") },
    { href: appPath("/analytics"), label: "Analytics", icon: BarChart3, match: navMatch("/analytics", "") },
    { href: appPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", "") },
    { href: appPath("/integrations"), label: SHOPIFY_INTEGRATION_LABEL, icon: Plug, match: navMatch("/integrations", "") },
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
    metrics: [
      { key: "carts_recovered", label: "Carts recovered", hint: "Checkouts an agent brought back" },
      { key: "revenue_recovered", label: "Revenue recovered" },
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
  nav: [
    { href: appPath(), label: "Home", icon: Rocket, match: navMatch("", "") },
    { href: appPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", "") },
    { href: appPath("/calls"), label: "Conversations", icon: PhoneCall, match: navMatch("/calls", "(/.*)?") },
    { href: appPath("/analytics"), label: "Analytics", icon: BarChart3, match: navMatch("/analytics", "") },
    { href: appPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", "") },
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
