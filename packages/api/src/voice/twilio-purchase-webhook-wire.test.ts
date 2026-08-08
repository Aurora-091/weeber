import { mock, describe, it, expect } from "bun:test";

/**
 * Wire contract for the number-purchase webhooks (defect, 2026-08-08).
 *
 * Every other test in this suite mocks the twilio module wholesale and asserts
 * the JavaScript arguments we hand it. That is structurally blind to the failure
 * that actually shipped: two numbers were purchased with voiceUrl and
 * statusCallback in the create call, and Twilio's own audit log recorded the
 * created resource with no voice_url and no status_callback — inert numbers that
 * ring and drop. Asserting our own arguments back to ourselves can never catch
 * a param that goes missing between the SDK and the HTTPS request.
 *
 * So this file drives the REAL twilio SDK with a recording httpClient and
 * asserts the serialised request body — the same probe that cleared the SDK
 * during the investigation, kept as a regression test. It fails if an SDK
 * upgrade renames or stops serialising any of these params, or if
 * NumberVoiceWebhooks ever grows a field the SDK silently ignores.
 *
 * The SDK is imported by its deep CJS path on purpose: sibling test files call
 * mock.module("twilio"), and those mocks are process-wide, so importing
 * "twilio" here could hand us a mock and quietly make this test meaningless.
 */

// twilio-provisioning imports ../database at load time (which would open a real
// connection) and ./twilio-client for getPublicUrl. Only those two are mocked —
// the SDK deliberately is not.
mock.module("../database", () => ({ db: {} }));
mock.module("./twilio-client", () => ({
  twilioClient: {},
  getPublicUrl: () => "https://api.weeber.test",
  resolveOrgTwilioCreds: async () => null,
}));

const { inboundVoiceWebhooks } = await import("./twilio-provisioning");
const twilioModule = await import("twilio/lib/rest/Twilio.js");
const TwilioClient = ((twilioModule as unknown as { default?: unknown }).default ?? twilioModule) as new (
  sid: string,
  token: string,
  opts: { httpClient: unknown },
) => {
  incomingPhoneNumbers: {
    create: (params: Record<string, unknown>) => Promise<{ sid: string }>;
  };
};

type Captured = { method: string; uri: string; data: Record<string, string> };

/** A Twilio httpClient that records the request and never leaves the process. */
function recordingClient(captured: Captured[]) {
  return {
    async request(opts: { method: string; uri: string; data?: Record<string, string> }) {
      captured.push({ method: opts.method, uri: opts.uri, data: opts.data ?? {} });
      return {
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: {
          sid: "PNtest",
          account_sid: "AC" + "0".repeat(32),
          phone_number: opts.data?.PhoneNumber ?? null,
          voice_url: opts.data?.VoiceUrl ?? null,
          voice_method: opts.data?.VoiceMethod ?? null,
          status_callback: opts.data?.StatusCallback ?? null,
          status_callback_method: opts.data?.StatusCallbackMethod ?? null,
          capabilities: {},
        },
      };
    },
  };
}

async function captureCreateRequest(phoneNumber: string): Promise<Captured> {
  const captured: Captured[] = [];
  const client = new TwilioClient("AC" + "0".repeat(32), "faketoken", { httpClient: recordingClient(captured) });
  // EXACTLY the call shape buyNumberForOrg uses.
  await client.incomingPhoneNumbers.create({ phoneNumber, ...inboundVoiceWebhooks() });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("number purchase — webhook wire contract", () => {
  it("puts VoiceUrl and StatusCallback on the actual HTTP request, not just in our arguments", async () => {
    const request = await captureCreateRequest("+15551110001");

    expect(request.method.toUpperCase()).toBe("POST");
    expect(request.uri).toContain("/IncomingPhoneNumbers.json");
    // The two params whose absence made both production numbers unanswerable.
    expect(request.data.VoiceUrl).toBe("https://api.weeber.test/api/voice/incoming");
    expect(request.data.StatusCallback).toBe("https://api.weeber.test/api/voice/status-callback");
    expect(request.data.VoiceMethod).toBe("POST");
    expect(request.data.StatusCallbackMethod).toBe("POST");
    expect(request.data.PhoneNumber).toBe("+15551110001");
  });

  it("drops no field of NumberVoiceWebhooks on the way to the wire", async () => {
    const request = await captureCreateRequest("+15551110002");

    // Every key of the webhook object must map to a serialised param. If
    // NumberVoiceWebhooks grows a field the SDK doesn't know, this fails rather
    // than letting the new field be silently ignored by Twilio.
    const expectedParams: Record<keyof ReturnType<typeof inboundVoiceWebhooks>, string> = {
      voiceUrl: "VoiceUrl",
      voiceMethod: "VoiceMethod",
      statusCallback: "StatusCallback",
      statusCallbackMethod: "StatusCallbackMethod",
    };
    for (const [field, value] of Object.entries(inboundVoiceWebhooks())) {
      const param = expectedParams[field as keyof typeof expectedParams];
      expect(param, `NumberVoiceWebhooks.${field} has no known Twilio param`).toBeDefined();
      expect(request.data[param], `${field} was not serialised as ${param}`).toBe(value);
    }
  });

  it("sends no voiceApplicationSid or trunkSid, which would make Twilio ignore VoiceUrl", async () => {
    const request = await captureCreateRequest("+15551110003");

    // Per Twilio's IncomingPhoneNumber docs these two override voice_url. Both
    // were confirmed unset on the affected numbers, and they must stay unset or
    // the webhook baked in at purchase time becomes dead config.
    expect(request.data.VoiceApplicationSid).toBeUndefined();
    expect(request.data.TrunkSid).toBeUndefined();
  });
});
