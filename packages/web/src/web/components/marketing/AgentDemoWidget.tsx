import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Square, ChevronLeft, ChevronRight, RotateCcw, MessageSquareText } from "lucide-react";
import { DEMOS } from "../../lib/marketing-config";

type Status = "idle" | "playing" | "done";
const BAR_COUNT = 20;

function DemoOrb({ color, status }: { color: string; status: Status }) {
  return (
    <div className="demo-orb-container">
      <div
        className={`demo-orb ${status === "playing" ? "demo-orb--playing" : ""} ${status === "done" ? "demo-orb--done" : ""}`}
        style={{ "--orb-color": color } as React.CSSProperties}
      >
        <div className="demo-orb-blob demo-orb-blob--1" />
        <div className="demo-orb-blob demo-orb-blob--2" />
        <div className="demo-orb-blob demo-orb-blob--3" />
      </div>
      <div className="demo-orb-glow" style={{ "--orb-color": color } as React.CSSProperties} />
    </div>
  );
}

/** Real audio-reactive bars — actually driven by the playing audio's frequency data (Web Audio
 * API AnalyserNode), not a canned CSS loop, so it genuinely tracks the call's energy instead of
 * just looking busy. Renders nothing while idle/done so it doesn't imply a call is happening
 * when it isn't. */
function LiveWaveform({ levels, active }: { levels: number[]; active: boolean }) {
  return (
    <div className={`demo-live-wave ${active ? "demo-live-wave--active" : ""}`} aria-hidden>
      {levels.map((v, i) => (
        <span key={i} className="demo-live-wave-bar" style={{ height: `${active ? Math.max(8, v * 100) : 8}%` }} />
      ))}
    </div>
  );
}

/** Ported verbatim from Vocalist's AgentDemoWidget.tsx (github.com/Aurora-091/Vocalist) —
 * real recorded demo call audio + synced transcript. */
export function AgentDemoWidget() {
  const [activeIdx, setActiveIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [visibleLines, setVisibleLines] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number>(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const [waveLevels, setWaveLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0.1));

  const demo = DEMOS[activeIdx];
  const isTranscriptOnly = demo.transcriptOnly;

  /** Lazily wires the currently-playing <audio> into an AnalyserNode — once per element (a new
   * <audio> mounts per demo via `key={demo.id}` below, so this is safe to call again per demo). */
  function ensureAnalyser() {
    const audio = audioRef.current;
    if (!audio || sourceRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioCtxRef.current ?? new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      sourceRef.current = source;
      freqDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch {
      // Web Audio unavailable/blocked (e.g. very old browser) — playback still works, the
      // waveform just stays flat. Not worth failing the whole demo over.
    }
  }

  const updateProgress = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    setProgress(pct);

    let count = 0;
    for (let i = 0; i < demo.transcript.length; i++) {
      if (pct >= demo.transcript[i]!.pct) count = i + 1;
    }
    setVisibleLines(count);

    const analyser = analyserRef.current;
    const freqData = freqDataRef.current;
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      const bins = freqData.length;
      const perBar = Math.max(1, Math.floor(bins / BAR_COUNT));
      const next: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = 0; j < perBar; j++) sum += freqData[i * perBar + j] ?? 0;
        next.push(Math.min(1, sum / perBar / 255));
      }
      setWaveLevels(next);
    }

    rafRef.current = requestAnimationFrame(updateProgress);
  }, [demo.transcript]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [visibleLines]);

  useEffect(() => {
    if (isTranscriptOnly) {
      setVisibleLines(demo.transcript.length);
      setProgress(100);
      setStatus("done");
    }
    // New demo -> new <audio> element (key={demo.id} below) -> analyser must be rebuilt, not reused.
    sourceRef.current = null;
    analyserRef.current = null;
    freqDataRef.current = null;
    setWaveLevels(Array(BAR_COUNT).fill(0.1));
  }, [activeIdx, isTranscriptOnly, demo.transcript.length]);

  function stopPlayback() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setStatus("idle");
    setProgress(0);
    setVisibleLines(0);
  }

  function handleNav(dir: -1 | 1) {
    stopPlayback();
    setActiveIdx((prev) => {
      const next = prev + dir;
      if (next < 0) return DEMOS.length - 1;
      if (next >= DEMOS.length) return 0;
      return next;
    });
  }

  function handlePlayToggle() {
    if (isTranscriptOnly) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (status === "playing") {
      audio.pause();
      setStatus("idle");
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    } else {
      if (status === "done") {
        audio.currentTime = 0;
        setVisibleLines(0);
        setProgress(0);
      }
      ensureAnalyser();
      audioCtxRef.current?.resume();
      audio.play();
      setStatus("playing");
      rafRef.current = requestAnimationFrame(updateProgress);
    }
  }

  function handleEnded() {
    setStatus("done");
    setProgress(100);
    setVisibleLines(demo.transcript.length);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }

  const elapsed = audioRef.current?.currentTime ?? 0;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.floor(elapsed % 60);
  const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  return (
    <div className="demo-widget">
      <div className="demo-nav">
        <button onClick={() => handleNav(-1)} className="demo-nav-arrow" aria-label="Previous demo">
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="demo-nav-center">
          <span className="demo-nav-title">{demo.title}</span>
          <span className="demo-nav-subtitle">{demo.subtitle}</span>
        </div>

        <button onClick={() => handleNav(1)} className="demo-nav-arrow" aria-label="Next demo">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="demo-dots">
        {DEMOS.map((_, i) => (
          <button
            key={i}
            onClick={() => {
              stopPlayback();
              setActiveIdx(i);
            }}
            className={`demo-dot ${i === activeIdx ? "demo-dot--active" : ""}`}
            style={i === activeIdx ? { background: demo.orbColor } : undefined}
            aria-label={`Demo ${i + 1}`}
          />
        ))}
      </div>

      <div className="demo-body">
        <div className="demo-orb-side">
          <div className="demo-orb-wrapper">
            <DemoOrb color={demo.orbColor} status={isTranscriptOnly ? "done" : status} />
            {isTranscriptOnly ? (
              <div className="demo-orb-play demo-orb-play--transcript-only">
                <MessageSquareText className="w-5 h-5" />
              </div>
            ) : (
              <button
                onClick={handlePlayToggle}
                className={`demo-orb-play ${status === "playing" ? "demo-orb-play--active" : ""}`}
                aria-label={status === "playing" ? "Stop" : "Play"}
              >
                {status === "playing" ? (
                  <Square className="w-5 h-5 fill-current" />
                ) : status === "done" ? (
                  <RotateCcw className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5 fill-current translate-x-[2px]" />
                )}
              </button>
            )}
          </div>

          <div className="demo-orb-status">
            {isTranscriptOnly ? (
              <span className="text-[var(--m-text-muted)] text-[13px]">Transcript only — audio coming soon</span>
            ) : (
              <>
                {status === "idle" && <span className="text-[var(--m-text-muted)] text-[13px]">Tap to listen</span>}
                {status === "playing" && (
                  <span className="demo-orb-live">
                    <span className="demo-orb-live-dot" />
                    AI calling... {timeStr}
                  </span>
                )}
                {status === "done" && (
                  <span className="text-[#16a34a] text-[13px] font-medium flex items-center gap-1.5">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l4 4 10-10" />
                    </svg>
                    Call complete
                  </span>
                )}
              </>
            )}
          </div>

          {!isTranscriptOnly && (
            <>
              <LiveWaveform levels={waveLevels} active={status === "playing"} />
              <div className="demo-progress-track">
                <div className="demo-progress-fill" style={{ width: `${progress}%`, background: demo.orbColor }} />
              </div>
            </>
          )}
        </div>

        <div className="demo-transcript-side" ref={transcriptRef}>
          <div className="demo-transcript-header">{isTranscriptOnly ? "Conversation transcript" : "Live transcript"}</div>
          <div className="demo-transcript-lines">
            {demo.transcript.slice(0, visibleLines).map((line, i) => (
              <div key={`${activeIdx}-${i}`} className={`demo-bubble ${line.speaker === "agent" ? "demo-bubble--agent" : "demo-bubble--customer"}`}>
                <span className="demo-bubble-label">{line.speaker === "agent" ? "Weeber" : "Customer"}</span>
                <span className="demo-bubble-text">{line.text}</span>
              </div>
            ))}
            {visibleLines === 0 && !isTranscriptOnly && <div className="demo-transcript-empty">Press play to hear {demo.title}...</div>}
          </div>
        </div>
      </div>

      {!isTranscriptOnly && demo.audioSrc && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- recorded demo call audio, transcript is shown alongside instead of a caption track
        <audio ref={audioRef} src={demo.audioSrc} preload="metadata" onEnded={handleEnded} key={demo.id} />
      )}
    </div>
  );
}
