import { useState } from "react";
import { KeyRound, Mail, Lock, Loader as Loader2 } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";

type Props = {
  onSuccess: () => void;
  onFallbackKey: () => void;
};

export function AdminLoginForm({ onSuccess, onFallbackKey }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setLoading(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError) {
      setError(authError.message === "Invalid login credentials"
        ? "Invalid email or password"
        : authError.message);
      setLoading(false);
      return;
    }

    onSuccess();
  }

  if (!supabaseConfigured) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        Supabase not configured — use an API key instead.
        <button
          type="button"
          onClick={onFallbackKey}
          className="block mx-auto mt-3 text-primary hover:underline text-sm"
        >
          Enter API key
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Email"
          required
          className="w-full rounded-md border border-border bg-card pl-10 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          required
          className="w-full rounded-md border border-border bg-card pl-10 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={loading || !email.trim() || !password}
        className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="size-4 animate-spin" />}
        Sign in
      </button>

      <button
        type="button"
        onClick={onFallbackKey}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
      >
        <KeyRound className="inline size-3 mr-1" />
        Use API key instead
      </button>
    </form>
  );
}
