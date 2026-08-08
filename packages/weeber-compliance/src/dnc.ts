import type { DncStorageAdapter } from "./storage";

/**
 * Do-Not-Call list enforcement — checked automatically before every outbound
 * call by the caller of this module (see README "Wiring it into your call
 * flow"). Bring your own storage by passing a DncStorageAdapter (see
 * adapters/memory.ts for a minimal reference, or implement one against your
 * own database in a few lines).
 *
 * National DNC Registry integration: the FTC's National DNC Registry requires
 * a paid Subscription Account Number (SAN) via telemarketing.donotcall.gov —
 * there is no free arbitrary-lookup API. `source: "national-registry"` is
 * reserved for numbers synced in from that feed once the operator has a SAN;
 * this module treats all sources identically, so turning on national-registry
 * sync later requires zero changes to the calling code — only a periodic job
 * that calls `addToDoNotCallList(number, reason, "national-registry")` for
 * each synced number.
 */
export async function isOnDoNotCallList(adapter: DncStorageAdapter, phoneNumber: string): Promise<boolean> {
  return adapter.isListed(phoneNumber);
}

export async function addToDoNotCallList(
  adapter: DncStorageAdapter,
  phoneNumber: string,
  reason?: string,
  source: "manual" | "agent" | "national-registry" = "manual",
): Promise<void> {
  await adapter.add({ phoneNumber, reason, source, addedAt: new Date() });
}

export async function removeFromDoNotCallList(adapter: DncStorageAdapter, phoneNumber: string): Promise<void> {
  await adapter.remove(phoneNumber);
}

export async function listDoNotCall(adapter: DncStorageAdapter) {
  return adapter.list();
}
