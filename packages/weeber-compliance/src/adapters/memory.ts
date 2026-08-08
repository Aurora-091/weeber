import type {
  CallLogStorageAdapter,
  CallRecord,
  ConsentPurpose,
  ConsentRecord,
  ConsentStorageAdapter,
  DncStorageAdapter,
  DoNotCallEntry,
} from "../storage";

/**
 * In-memory reference adapters — useful for tests, quick prototypes, or a
 * single-process deployment where persistence across restarts doesn't
 * matter. Not suitable for production (state is lost on restart, doesn't
 * share across instances). Swap for a real database-backed adapter before
 * shipping — see the package README for the Drizzle/Turso example used by
 * the Weeber app.
 */
export function createMemoryDncAdapter(): DncStorageAdapter {
  const entries = new Map<string, DoNotCallEntry>();
  return {
    async isListed(phoneNumber) {
      return entries.has(phoneNumber);
    },
    async add(entry) {
      entries.set(entry.phoneNumber, entry);
    },
    async remove(phoneNumber) {
      entries.delete(phoneNumber);
    },
    async list() {
      return [...entries.values()];
    },
  };
}

/**
 * In-memory consent ledger — same reference-implementation caveats as
 * createMemoryDncAdapter above (not for production use). Stores every grant/withdrawal as an
 * append-only list per (dataPrincipal, purpose), matching the real ledger semantics a Drizzle
 * adapter needs to preserve (see docs/global-compliance-engine-plan.md Tier 0 #6).
 */
export function createMemoryConsentAdapter(): ConsentStorageAdapter & {
  seed: (records: ConsentRecord[]) => void;
} {
  let records: ConsentRecord[] = [];
  function activeGrant(dataPrincipal: string, purpose: ConsentPurpose): ConsentRecord | undefined {
    return [...records]
      .filter((r) => r.dataPrincipal === dataPrincipal && r.purpose === purpose)
      .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
      .find((r) => r.granted && !r.withdrawnAt && (!r.expiresAt || r.expiresAt.getTime() > Date.now()));
  }
  return {
    seed(seedRecords) {
      records = seedRecords;
    },
    async hasConsent(dataPrincipal, purpose) {
      return Boolean(activeGrant(dataPrincipal, purpose));
    },
    async grant(record) {
      records.push(record);
    },
    async withdraw(dataPrincipal, purpose) {
      const active = activeGrant(dataPrincipal, purpose);
      if (active) active.withdrawnAt = new Date();
    },
    async listForPrincipal(dataPrincipal) {
      return records.filter((r) => r.dataPrincipal === dataPrincipal);
    },
  };
}

export function createMemoryCallLogAdapter(): CallLogStorageAdapter & {
  seed: (calls: CallRecord[]) => void;
} {
  let calls: CallRecord[] = [];
  return {
    seed(records) {
      calls = records;
    },
    async findCallsStartedBefore(cutoff) {
      return calls.filter((c) => c.startedAt < cutoff);
    },
    async findCallsByPhoneNumber(phoneNumber) {
      return calls.filter((c) => c.fromNumber === phoneNumber || c.toNumber === phoneNumber);
    },
    async deleteCall(callId) {
      calls = calls.filter((c) => c.id !== callId);
    },
  };
}
