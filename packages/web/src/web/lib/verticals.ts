import { Rocket, Bot, PhoneCall, BarChart3, CreditCard, Plug } from "lucide-react";
import type { NavItem } from "../components/shell/app-shell";

/**
 * Vertical-driven merchant UI (MERCHANT-APP-PAGE-MAP §4, ADR-031's seam
 * carried into the frontend): nav, labels, and copy are data per vertical,
 * not JSX branches. Shopify is the only vertical with real agents today; a
 * clinic/hotel vertical adds an entry here (+ agentTemplates rows on the
 * backend) — no shared-component changes.
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
};

const shopify: VerticalDefinition = {
  key: "shopify",
  glossary: { customer: "Customer", customers: "Customers" },
  integrationLabel: "Shopify",
  nav: [
    { href: "/app/onboarding", label: "Setup", icon: Rocket, match: /^\/app(\/onboarding)?$/ },
    { href: "/app/agents", label: "Agents", icon: Bot, match: /^\/app\/agents$/ },
    { href: "/app/calls", label: "Conversations", icon: PhoneCall, match: /^\/app\/calls(\/.*)?$/ },
    { href: "/app/analytics", label: "Analytics", icon: BarChart3, match: /^\/app\/analytics$/ },
    { href: "/app/billing", label: "Billing", icon: CreditCard, match: /^\/app\/billing$/ },
    { href: "/app/integrations", label: "Integrations", icon: Plug, match: /^\/app\/integrations$/ },
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
};

const VERTICALS: Record<string, VerticalDefinition> = { shopify };

export function getVertical(key: string | null | undefined): VerticalDefinition {
  return VERTICALS[key ?? "shopify"] ?? shopify;
}
