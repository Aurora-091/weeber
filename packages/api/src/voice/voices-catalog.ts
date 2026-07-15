/**
 * Dynamic per-provider voice catalog for the dashboard's voice picker
 * (agents.tsx). Replaces the old "type in a voice ID you already know"
 * text field with a real browsable list — competitor platforms (Retell,
 * Vapi) both do this: a searchable dropdown with an instant, canned-sample
 * play button per voice, not a blind text field.
 *
 * Preview playback strategy differs per provider (see each list*Voices
 * function's doc comment) because their APIs genuinely differ here — this
 * isn't a design choice, it's what each provider actually supports:
 *   - ElevenLabs: public preview URL, embeddable client-side directly.
 *   - Cartesia: preview URL requires the same Authorization header as the
 *     API itself, so it can't be embedded client-side — proxied through
 *     `/voices/cartesia-preview/:id` below instead.
 *   - Sarvam: no list-voices/preview API exists at all — a fixed named
 *     speaker list per model, no instant sample; the dashboard falls back
 *     to generating a real (slower, costs credits) preview on demand via
 *     the existing /voice-preview endpoint for this provider only.
 */

export type CatalogVoice = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: string;
  /** Null when no instant/canned sample exists for this voice (Sarvam) —
   * the frontend falls back to on-demand generation in that case. */
  previewUrl: string | null;
};

type CacheEntry = { voices: CatalogVoice[]; expiresAt: number };
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, CacheEntry>();

async function withCache(key: string, fetcher: () => Promise<CatalogVoice[]>): Promise<CatalogVoice[]> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.voices;
  const voices = await fetcher();
  cache.set(key, { voices, expiresAt: Date.now() + CACHE_TTL_MS });
  return voices;
}

export async function listElevenLabsVoices(): Promise<CatalogVoice[]> {
  return withCache("elevenlabs", async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return [];
    const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      console.error("[voices-catalog] ElevenLabs voice list failed", res.status, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as { voices?: Array<Record<string, unknown>> };
    return (data.voices ?? []).map((v) => ({
      id: String(v.voice_id ?? ""),
      name: String(v.name ?? "Unnamed voice"),
      description: typeof v.description === "string" ? v.description : undefined,
      language: extractLabel(v, "language"),
      gender: extractLabel(v, "gender"),
      previewUrl: typeof v.preview_url === "string" ? v.preview_url : null,
    }));
  });
}

function extractLabel(voice: Record<string, unknown>, key: string): string | undefined {
  const labels = voice.labels as Record<string, string> | undefined;
  return labels?.[key];
}

export async function listCartesiaVoices(scope: "admin" | "user" = "admin"): Promise<CatalogVoice[]> {
  return withCache(`cartesia:${scope}`, async () => {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) return [];
    const res = await fetch("https://api.cartesia.ai/voices?limit=100&expand[]=preview_file_url", {
      headers: { "X-API-Key": apiKey, "Cartesia-Version": "2025-11-04" },
    });
    if (!res.ok) {
      console.error("[voices-catalog] Cartesia voice list failed", res.status, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    // Preview proxy is mounted under both /api/voice (admin, requireAdminKey)
    // and /api/app (merchant, session-scoped) — see routes.ts in each. This
    // must match whichever scope actually called listVoicesForProvider, or
    // the merchant surface silently 401s hitting the admin-only path (fixed
    // 2026-07-15: previously always hardcoded to the admin path, so every
    // merchant's inline voice preview button did nothing, no error surfaced).
    const previewBase = scope === "admin" ? "/api/voice/voices/cartesia-preview" : "/api/app/voices/cartesia-preview";
    return (data.data ?? []).map((v) => ({
      id: String(v.id ?? ""),
      name: String(v.name ?? "Unnamed voice"),
      description: typeof v.description === "string" ? v.description : undefined,
      language: typeof v.language === "string" ? v.language : undefined,
      gender: typeof v.gender === "string" ? v.gender : undefined,
      // Never the raw preview_file_url — it requires our API key to fetch,
      // so the frontend goes through our own proxy route instead.
      previewUrl: v.preview_file_url ? `${previewBase}/${encodeURIComponent(String(v.id))}` : null,
    }));
  });
}

/** bulbul:v2 and bulbul:v3 speakers — Sarvam has no list-voices API, this
 * is the fixed named set from their docs (see stt/sarvam.ts and
 * tts/sarvam.ts's doc comments for the same source). No instant preview
 * exists for any of these. */
const SARVAM_V2_VOICES: CatalogVoice[] = [
  { id: "anushka", name: "Anushka", gender: "female", previewUrl: null },
  { id: "manisha", name: "Manisha", gender: "female", previewUrl: null },
  { id: "vidya", name: "Vidya", gender: "female", previewUrl: null },
  { id: "arya", name: "Arya", gender: "female", previewUrl: null },
  { id: "abhilash", name: "Abhilash", gender: "male", previewUrl: null },
  { id: "karun", name: "Karun", gender: "male", previewUrl: null },
  { id: "hitesh", name: "Hitesh", gender: "male", previewUrl: null },
];

const SARVAM_V3_VOICE_NAMES = [
  "shubh", "aditya", "ritu", "priya", "neha", "rahul", "pooja", "rohan", "simran", "kavya", "amit",
  "dev", "ishita", "shreya", "ratan", "varun", "manan", "sumit", "roopa", "kabir", "aayan", "ashutosh",
  "advait", "anand", "tanya", "tarun", "sunny", "mani", "gokul", "vijay", "shruti", "suhani", "mohit",
  "kavitha", "rehan", "soham", "rupali",
];

export async function listSarvamVoices(): Promise<CatalogVoice[]> {
  const v3 = SARVAM_V3_VOICE_NAMES.map((name) => ({
    id: name,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    description: "bulbul:v3",
    previewUrl: null,
  }));
  return [...SARVAM_V2_VOICES.map((v) => ({ ...v, description: "bulbul:v2" })), ...v3];
}

export async function listVoicesForProvider(provider: string, scope: "admin" | "user" = "admin"): Promise<CatalogVoice[]> {
  if (provider === "elevenlabs") return listElevenLabsVoices();
  if (provider === "cartesia") return listCartesiaVoices(scope);
  if (provider === "sarvam") return listSarvamVoices();
  return [];
}

/** Proxies a Cartesia preview file server-side — the URL Cartesia returns
 * requires the same Authorization the API itself needs, so the browser
 * can't fetch it directly. Returns null on any failure so the route layer
 * can respond with a clean 502 instead of throwing. */
export async function fetchCartesiaPreviewAudio(voiceId: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) return null;
  try {
    const voiceRes = await fetch(`https://api.cartesia.ai/voices/${encodeURIComponent(voiceId)}?expand[]=preview_file_url`, {
      headers: { "X-API-Key": apiKey, "Cartesia-Version": "2025-11-04" },
    });
    if (!voiceRes.ok) return null;
    const voice = (await voiceRes.json()) as { preview_file_url?: string };
    if (!voice.preview_file_url) return null;

    const audioRes = await fetch(voice.preview_file_url, { headers: { "X-API-Key": apiKey } });
    if (!audioRes.ok) return null;
    return { body: await audioRes.arrayBuffer(), contentType: audioRes.headers.get("content-type") ?? "audio/mpeg" };
  } catch (err) {
    console.error("[voices-catalog] Cartesia preview proxy failed", err);
    return null;
  }
}
