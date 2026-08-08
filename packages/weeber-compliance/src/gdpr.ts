import type { CallLogStorageAdapter } from "./storage";
import { isHipaaMode, getHipaaRetentionDays } from "./hipaa";

/**
 * GDPR-oriented data lifecycle controls — the two concretely codeable pieces
 * of GDPR: bounded retention (Art. 5(1)(e) storage limitation) and the
 * right to erasure (Art. 17). Both operate against a CallLogStorageAdapter
 * you provide (see storage.ts) — this package has no opinion on your schema,
 * only on the retention/erasure behavior.
 */
export type GdprOptions = {
  retentionDays?: number;
};

function readEnv(key: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[key] : undefined;
}

export function getRetentionDays(options: GdprOptions = {}): number {
  if (options.retentionDays !== undefined) return options.retentionDays;
  if (isHipaaMode()) return getHipaaRetentionDays();
  const configured = readEnv("DATA_RETENTION_DAYS");
  return configured ? Number(configured) : 90;
}

/** Deletes call records (and whatever the adapter cascades) older than the retention window. Safe to run repeatedly. */
export async function purgeExpiredData(
  adapter: CallLogStorageAdapter,
  options: GdprOptions = {},
): Promise<{ callsDeleted: number }> {
  const retentionDays = getRetentionDays(options);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expiredCalls = await adapter.findCallsStartedBefore(cutoff);
  for (const call of expiredCalls) {
    await adapter.deleteCall(call.id);
  }

  return { callsDeleted: expiredCalls.length };
}

/** Right-to-erasure: deletes all call data associated with a phone number, on request. */
export async function eraseCallerData(
  adapter: CallLogStorageAdapter,
  phoneNumber: string,
): Promise<{ callsDeleted: number }> {
  const matches = await adapter.findCallsByPhoneNumber(phoneNumber);
  for (const call of matches) {
    await adapter.deleteCall(call.id);
  }
  return { callsDeleted: matches.length };
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

/** Starts a background retention-purge sweep. Call once at process boot. Returns a stop function. */
export function startRetentionSweep(
  adapter: CallLogStorageAdapter,
  options: GdprOptions & { onPurge?: (result: { callsDeleted: number }) => void; onError?: (err: unknown) => void } = {},
): () => void {
  if (typeof setInterval === "undefined") return () => {};

  const run = () => {
    purgeExpiredData(adapter, options)
      .then((result) => {
        if (result.callsDeleted > 0) options.onPurge?.(result);
      })
      .catch((err) => options.onError?.(err));
  };

  run();
  const timer = setInterval(run, PURGE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
