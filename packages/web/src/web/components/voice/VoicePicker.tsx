import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Pause, Play, Search, Volume2, X } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { appFetch } from "../../lib/user-session";

export type VoiceOption = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: string;
  previewUrl: string | null;
};

type VoicePickerScope = "admin" | "user";

type VoicePickerProps = {
  provider: string;
  value: string;
  language?: string;
  onChange: (voiceId: string) => void;
  scope: VoicePickerScope;
  className?: string;
  previewText?: string;
};

/**
 * Competitive voice-picker UX (Retell/Vapi pattern): browse a provider's
 * voices in a searchable dropdown, pick one by name, and play a sample
 * inline. This is the SINGLE preview mechanism for the agent config page —
 * there used to be a second, separate "Hear it" button + bare <audio>
 * element next to this component doing a slightly different one-shot
 * preview; that redundancy is gone (2026-07-15 agent-page rebuild). The
 * always-visible play control on the closed trigger below is what replaces
 * it: you can preview the *currently selected* voice without opening the
 * browse popover at all.
 */
export function VoicePicker({ provider, value, language, onChange, scope, className, previewText }: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const voices = useQuery<{ voices: VoiceOption[] }>({
    queryKey: ["voices", scope, provider],
    enabled: provider === "elevenlabs" || provider === "cartesia" || provider === "sarvam",
    queryFn: async () => {
      const path = scope === "admin" ? `/api/voice/voices?provider=${encodeURIComponent(provider)}` : `/api/app/voices?provider=${encodeURIComponent(provider)}`;
      const res = scope === "admin" ? await apiFetch(path, { headers: adminHeaders() }) : await appFetch(path);
      if (!res.ok) throw new Error("Failed to load voices");
      return res.json();
    },
  });

  const list = useMemo(() => voices.data?.voices ?? [], [voices.data]);
  const selected = list.find((v) => v.id === value) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((v) => [v.name, v.id, v.description, v.language, v.gender].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [list, query]);

  async function playVoice(voice: VoiceOption) {
    try {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingId(voice.id);

      if (voice.previewUrl) {
        let src = voice.previewUrl;
        if (voice.previewUrl.startsWith("/api/")) {
          // Cartesia preview URLs must be proxied through our backend and
          // therefore need auth headers; <audio src> cannot attach those.
          const res = scope === "admin" ? await apiFetch(voice.previewUrl, { headers: adminHeaders() }) : await appFetch(voice.previewUrl);
          if (!res.ok) throw new Error(`Preview failed (${res.status})`);
          src = URL.createObjectURL(await res.blob());
        }
        const audio = new Audio(src);
        audioRef.current = audio;
        audio.onended = () => setPlayingId(null);
        audio.onerror = () => {
          setPlayingId(null);
          toast.error("Couldn't play that voice sample", { description: "Try again in a moment." });
        };
        await audio.play();
        return;
      }

      // Sarvam (and any provider voice without a canned sample): no instant
      // provider-hosted preview exists, so fall back to our existing real TTS
      // preview route. This is intentionally slower and should be the
      // exception, not the default browsing path.
      setGeneratingId(voice.id);
      const path = scope === "admin" ? "/api/voice/voice-preview" : "/api/app/voice-preview";
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(scope === "admin" ? adminHeaders() : {}) },
        body: JSON.stringify({
          text: previewText || "Hi, this is Weeber. I can help with bookings, cart recovery, and follow-ups.",
          voiceProvider: provider,
          voiceId: voice.id,
          language,
        }),
      };
      const res = scope === "admin" ? await apiFetch(path, init) : await appFetch(path, init);
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => {
        setPlayingId(null);
        setGeneratingId(null);
      };
      audio.onerror = () => {
        setPlayingId(null);
        setGeneratingId(null);
        toast.error("Couldn't play that voice sample", { description: "Try again in a moment." });
      };
      await audio.play();
    } catch (err) {
      setPlayingId(null);
      setGeneratingId(null);
      toast.error("Voice preview failed", { description: err instanceof Error ? err.message : "Try again in a moment." });
    }
  }

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
    setGeneratingId(null);
  }

  return (
    <div className={`relative flex items-stretch gap-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm outline-none focus:ring-2 focus:ring-ring/40"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{selected?.name ?? (value ? value : "Select a voice")}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {selected ? [selected.language, selected.gender, selected.description].filter(Boolean).join(" · ") : "Browse provider voices and preview instantly"}
          </span>
        </span>
        <ChevronDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
      </button>

      {/* Always-visible preview control for whatever's currently selected —
       * this is what replaced the separate "Hear it" button. No need to
       * open the browse popover just to re-hear the current pick. */}
      {selected && (
        <button
          type="button"
          onClick={() => (playingId === selected.id ? stopPreview() : playVoice(selected))}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted transition-colors"
          aria-label={playingId === selected.id ? `Stop preview of ${selected.name}` : `Preview ${selected.name}`}
          title="Preview the currently selected voice"
        >
          {generatingId === selected.id ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : playingId === selected.id ? (
            <Pause className="size-3.5" aria-hidden />
          ) : (
            <Play className="size-3.5" aria-hidden />
          )}
          <span className="hidden sm:inline">{playingId === selected.id ? "Playing…" : "Preview"}</span>
        </button>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-4 text-muted-foreground" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices..." className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            <button type="button" onClick={() => setOpen(false)} className="rounded p-1 hover:bg-muted" aria-label="Close voice picker">
              <X className="size-3.5" />
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {voices.isLoading && (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading voices...
              </div>
            )}
            {voices.isError && <div className="px-3 py-6 text-sm text-destructive">Could not load voices for this provider.</div>}
            {!voices.isLoading && filtered.length === 0 && <div className="px-3 py-6 text-sm text-muted-foreground">No voices found.</div>}
            {filtered.map((voice) => (
              <div key={voice.id} className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted">
                <button
                  type="button"
                  onClick={() => {
                    onChange(voice.id);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{voice.name}</span>
                    {voice.id === value && <Check className="size-3.5 text-success" />}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{[voice.language, voice.gender, voice.description || voice.id].filter(Boolean).join(" · ")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => (playingId === voice.id ? stopPreview() : playVoice(voice))}
                  className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-background hover:bg-muted"
                  aria-label={`Preview ${voice.name}`}
                  title={voice.previewUrl ? "Play instant voice sample" : "Generate preview sample"}
                >
                  {generatingId === voice.id ? <Loader2 className="size-3.5 animate-spin" /> : playingId === voice.id ? <Volume2 className="size-3.5" /> : <Play className="size-3.5" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
