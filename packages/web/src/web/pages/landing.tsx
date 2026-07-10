import { useState } from "react";
import { Link } from "wouter";
import { Loader2, Check, ArrowRight, PhoneCall, ShieldCheck, Zap } from "lucide-react";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { apiFetch } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

const FEATURES = [
  {
    icon: PhoneCall,
    title: "Vertical voice agents",
    body: "Pre-built for Shopify (order status, abandoned-cart recovery) and clinics (booking, reminders, no-show follow-up). Not a generic bot builder.",
  },
  {
    icon: ShieldCheck,
    title: "Compliance baked in",
    body: "TCPA-aware calling windows, Do-Not-Call list enforcement, and a full audit trail on every outbound call — not bolted on after the fact.",
  },
  {
    icon: Zap,
    title: "Live in an afternoon",
    body: "Answer a short setup wizard, upload your knowledge base, get a phone number. No prompt engineering required.",
  },
];

function LandingContent() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "landing" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Something went wrong — try again.");
        return;
      }
      setJoined(true);
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Nav */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="flex items-baseline gap-1.5">
            <span className="font-serif text-lg font-medium tracking-tight">Weeber</span>
          </span>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">
              Features
            </a>
            <Link href="/app/login" className="hover:text-foreground">
              Merchant login
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
        <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Voice AI for Shopify &amp; clinics
        </p>
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
          Phone agents that actually run your business, not just answer it.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
          Weeber gives Shopify stores and clinics a phone number backed by an AI agent that recovers
          abandoned carts, answers order questions, and books appointments — compliant by default.
        </p>

        <form onSubmit={submit} className="mx-auto mt-8 flex max-w-md flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            required
            placeholder="you@yourstore.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending || joined}
            className="flex-1"
          />
          <Button type="submit" disabled={pending || joined}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {joined ? (
              <>
                <Check className="size-4" aria-hidden /> On the list
              </>
            ) : (
              <>
                Join the waitlist <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </Button>
        </form>
        {error && <p className="mt-3 text-sm text-error">{error}</p>}
        {joined && !error && (
          <p className="mt-3 text-sm text-success">You're in — we'll reach out when a slot opens up.</p>
        )}
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="grid gap-10 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <f.icon className="size-5 text-foreground" aria-hidden />
                <h3 className="mt-3 text-sm font-medium">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>&copy; {new Date().getFullYear()} Weeber. All rights reserved.</span>
          <Link href="/app/login" className="hover:text-foreground">
            Merchant login
          </Link>
        </div>
      </footer>
    </div>
  );
}

export default function LandingPage() {
  const { theme } = useTheme();
  return (
    <div className={cn("theme-weeber", theme === "dark" && "dark")}>
      <LandingContent />
    </div>
  );
}
