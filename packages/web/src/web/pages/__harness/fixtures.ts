/**
 * Shared mock context for the two non-production harnesses:
 *   - pages/__preview.tsx  — interactive, DEV-only, human inspection
 *   - pages/__harness/     — URL-addressable, drives e2e/visual.spec.ts
 *
 * One definition of the mock org/user so the two harnesses cannot drift apart
 * and then disagree about what a screenshot is supposed to contain.
 *
 * Never imported from production code. See __harness/index.tsx for how the
 * route is gated out of normal builds.
 */
import { QueryClient } from "@tanstack/react-query";
import type { UserMe } from "../../components/app/user-shell";

/**
 * A settled, offline QueryClient.
 *
 * retry:false + staleTime:Infinity + gcTime:Infinity means every query either
 * reads pre-seeded data or fails exactly once and stays failed. Without this a
 * screenshot can catch a retry mid-flight and the same commit produces two
 * different pixels.
 */
export function makeHarnessClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Mock /app/me payload. Values are deliberately boring and FIXED — no dates,
 * no counts, nothing derived from Date.now(), because anything time-derived
 * renders differently on every run and turns the visual gate into a coin flip.
 */
export const mockMe: UserMe = {
  user: { id: "harness-user", email: "harness@weeber.ai" },
  role: "owner",
  needsOnboarding: false,
  org: {
    id: "harness-org",
    name: "Harness Store",
    status: "active",
    vertical: "shopify",
    planName: "Growth",
    currency: "USD",
    countryCode: "US",
    timezone: "UTC",
    contactEmail: "harness@weeber.ai",
    webhookUrl: null,
    humanTransferNumber: null,
    callingWindowTestModeUntil: null,
  },
};
