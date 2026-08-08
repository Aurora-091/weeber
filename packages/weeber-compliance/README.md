# @weeber/compliance

Framework-agnostic compliance primitives for voice agents — automatic TCPA calling-window checks,
Do-Not-Call enforcement, recording/AI consent disclosure, a HIPAA boot-time guardrail, and GDPR
retention/erasure. Internal Weeber package, kept deliberately dependency-free (no Twilio, no Bun, no
specific database) so it stays testable and portable in isolation from the rest of `packages/web` — see
`CLAUDE.md`'s "Compliance package" note for why this gets a higher correctness bar than average.

**No Twilio, no Bun, no specific database required.** Bring your own storage by implementing two small
adapter interfaces (see [Storage adapters](#storage-adapters)) — or use the in-memory reference adapters to
get started in under a minute.

## Why this exists

Every open-source voice-agent orchestration framework (Pipecat, LiveKit Agents, TEN Framework, Vocode) and
every hosted platform treats compliance as entirely out of scope — it's plumbing for
audio/STT/LLM/TTS, full stop. None of them ship Do-Not-Call enforcement, TCPA calling-window checks,
automatic consent disclosure, or a HIPAA-readiness gate as a built-in concern. This package is that missing
layer, designed to sit in front of *any* telephony/voice pipeline.

## Usage (workspace-internal)

```ts
import {
  checkOutboundCallCompliance,
  createMemoryDncAdapter,
  withDisclosure,
} from "@weeber/compliance";

const dnc = createMemoryDncAdapter(); // swap for a real adapter in production — see below

async function placeOutboundCall(toNumber: string) {
  const check = await checkOutboundCallCompliance(toNumber, dnc);
  if (!check.allowed) {
    console.warn(`Call to ${toNumber} blocked: ${check.reason}`);
    return;
  }

  const persona = withDisclosure("You are a friendly scheduling assistant.");
  // ...place the call with your telephony/voice pipeline, using `persona`
  // as the agent's system prompt so the disclosure is spoken automatically.
}
```

## What's included

| Module | What it does |
|---|---|
| `calling-window` | TCPA-style enforcement: blocks outbound calls outside 8am-9pm in the called party's local time (best-effort NANP area-code timezone lookup, safe fallback when unresolved) |
| `dnc` | Do-Not-Call list enforcement — bring your own storage adapter |
| `consent` | Injects a spoken recording/AI-disclosure line into your agent's persona/system prompt, on by default |
| `hipaa` | A boot-time guardrail: refuses to proceed in HIPAA mode unless you've explicitly confirmed BAAs are signed — a human checkpoint, not a certification |
| `gdpr` | Retention purge (auto-delete call data older than N days) and right-to-erasure, against your own call-log storage |
| `checkOutboundCallCompliance` | The one call most integrations need — runs DNC + calling-window together |

## Storage adapters

This package never assumes a database. Two small interfaces are all it needs:

```ts
type DncStorageAdapter = {
  isListed(phoneNumber: string): Promise<boolean>;
  add(entry: DoNotCallEntry): Promise<void>;
  remove(phoneNumber: string): Promise<void>;
  list(): Promise<DoNotCallEntry[]>;
};

type CallLogStorageAdapter = {
  findCallsStartedBefore(cutoff: Date): Promise<CallRecord[]>;
  findCallsByPhoneNumber(phoneNumber: string): Promise<CallRecord[]>;
  deleteCall(callId: string): Promise<void>;
};
```

`createMemoryDncAdapter()` / `createMemoryCallLogAdapter()` are in-memory reference implementations —
fine for tests or a single-process prototype, not for production (state doesn't survive a restart). For
production, implement these against whatever you already use. Example against Drizzle:

```ts
import { db } from "./db";
import { doNotCall } from "./schema";
import { eq } from "drizzle-orm";
import type { DncStorageAdapter } from "@weeber/compliance";

export const drizzleDncAdapter: DncStorageAdapter = {
  async isListed(phoneNumber) {
    const [row] = await db.select().from(doNotCall).where(eq(doNotCall.phoneNumber, phoneNumber)).limit(1);
    return Boolean(row);
  },
  async add(entry) {
    await db.insert(doNotCall).values(entry).onConflictDoNothing();
  },
  async remove(phoneNumber) {
    await db.delete(doNotCall).where(eq(doNotCall.phoneNumber, phoneNumber));
  },
  async list() {
    return db.select().from(doNotCall);
  },
};
```

## HIPAA mode

```ts
import { assertHipaaPreflight } from "@weeber/compliance";

// Call once at process boot.
assertHipaaPreflight({ enabled: true, baaConfirmed: true });
```

Or drive it from environment variables (`COMPLIANCE_MODE=hipaa`, `HIPAA_BAA_CONFIRMED=true`) by omitting
the options object — every function in this package falls back to `process.env` when no explicit option is
passed, so zero-config usage and explicit config both work.

**This is a guardrail, not a certification.** No package can verify a signed Business Associate Agreement —
that's a legal contract between you and each vendor touching PHI (telephony, STT, TTS, LLM providers). This
module only ensures nobody silently skipped that step.

## GDPR retention + erasure

```ts
import { startRetentionSweep, eraseCallerData } from "@weeber/compliance";
import { myCallLogAdapter } from "./my-adapter";

// Runs once at boot, then daily — deletes call data older than DATA_RETENTION_DAYS (default 90).
startRetentionSweep(myCallLogAdapter, {
  onPurge: (result) => console.log(`Purged ${result.callsDeleted} expired calls`),
});

// On-demand, e.g. from a DELETE /callers/:phoneNumber endpoint:
await eraseCallerData(myCallLogAdapter, "+15551234567");
```

## What this package is not

- Not a telephony SDK — it doesn't place calls, doesn't touch Twilio/SIP/WebRTC.
- Not a certification — using this package doesn't make you SOC 2 / HIPAA / GDPR certified. It gives you
  automatic technical guardrails; the legal and audit work is still yours.
- Not a replacement for the National DNC Registry if you need it — that requires a paid Subscription
  Account Number from the FTC (telemarketing.donotcall.gov). This package's `dnc` module fully enforces an
  internal list automatically; syncing the national registry is a matter of populating that same list via
  a periodic job (`source: "national-registry"` is reserved for exactly this).
