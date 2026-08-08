import type { DncStorageAdapter } from "./storage";
import { addToDoNotCallList } from "./dnc";

/**
 * National DNC Registry sync — a documented drop-in point, not a working
 * integration. The FTC's National Do Not Call Registry has no free
 * arbitrary-lookup API; bulk/periodic access requires a paid Subscription
 * Account Number (SAN) obtained via telemarketing.donotcall.gov. This module
 * defines the shape a real sync job would use, so wiring one in later is a
 * matter of implementing `NationalRegistryFetcher` against your SAN
 * credentials — no changes needed anywhere else, since `addToDoNotCallList`
 * already treats `source: "national-registry"` identically to manual/agent
 * entries in every enforcement check.
 *
 * The registry publishes numbers as area-code-plus-exchange (NPA-NXX) files
 * for subscribers, refreshed periodically — the FTC requires re-downloading
 * at least every 31 days to stay compliant.
 */
export type NationalRegistryFetcher = {
  /**
   * Return the full (or incremental) set of phone numbers currently on the
   * national registry that are relevant to your calling area, as E.164
   * strings. Implement this against your SAN-authenticated download/API
   * once you have one — the FTC does not provide a standard REST API, only
   * bulk file downloads keyed by area code, so this is typically a
   * file-parsing job, not an HTTP client.
   */
  fetchRegisteredNumbers(): Promise<string[]>;
};

export type NationalDncSyncResult = {
  numbersSynced: number;
  fetchedAt: Date;
};

/**
 * Syncs the national registry into your own DNC storage. Call this
 * periodically (e.g. a daily/weekly cron) once you have a real
 * NationalRegistryFetcher — running it more often than the FTC's 31-day
 * refresh requirement isn't necessary, but more frequent local syncs are
 * harmless since this only ever adds entries, never removes ones added by
 * other sources.
 */
export async function syncNationalDncRegistry(
  adapter: DncStorageAdapter,
  fetcher: NationalRegistryFetcher,
): Promise<NationalDncSyncResult> {
  const numbers = await fetcher.fetchRegisteredNumbers();
  for (const phoneNumber of numbers) {
    await addToDoNotCallList(adapter, phoneNumber, "synced from National DNC Registry", "national-registry");
  }
  return { numbersSynced: numbers.length, fetchedAt: new Date() };
}

/**
 * A fetcher that always returns an empty list — useful as an explicit
 * placeholder until a real SAN-backed fetcher is implemented, so a
 * misconfigured deployment doesn't silently skip national registry sync
 * without anyone noticing. Wiring code that calls syncNationalDncRegistry
 * with this fetcher will complete successfully but sync zero numbers.
 */
export const noopNationalRegistryFetcher: NationalRegistryFetcher = {
  async fetchRegisteredNumbers() {
    return [];
  },
};
