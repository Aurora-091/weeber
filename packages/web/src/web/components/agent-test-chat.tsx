import { useState, useRef, useEffect } from "react";
import { Send, Loader as Loader2, Bot, User } from "lucide-react";

type Message = {
  role: "user" | "assistant";
  content: string;
  latencyMs?: number;
  estimatedCost?: number;
  model?: string;
  toolCalls?: { name: string; input: unknown }[];
};

type TestChatProps = {
  fetchFn: (messages: { role: string; content: string }[]) => Promise<Response>;
  templateName: string;
};

export function AgentTestChat({ fetchFn, templateName }: TestChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const userMsg: Message = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setLoading(true);

    try {
      const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
      const res = await fetchFn(apiMessages);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages([...history, { role: "assistant", content: `Error: ${err.error ?? res.statusText}` }]);
        return;
      }
      const data = await res.json();
      const assistantMsg: Message = {
        role: "assistant",
        content: data.response,
        latencyMs: data.latencyMs,
        estimatedCost: data.estimatedCost,
        model: data.model,
        toolCalls: data.toolCalls,
      };
      setMessages([...history, assistantMsg]);
    } catch (err) {
      setMessages([...history, { role: "assistant", content: `Network error: ${String(err)}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4 text-primary" />
          Test {templateName}
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div ref={scrollRef} className="h-72 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Type a message to test this agent's responses. This sandbox uses the agent's real config
            (persona, tools, guardrails) without placing a call.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="shrink-0 mt-0.5">
                <Bot className="size-4 text-primary" />
              </div>
            )}
            <div className={`max-w-[80%] ${msg.role === "user" ? "order-first" : ""}`}>
              <div
                className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 border border-border"
                }`}
              >
                {msg.content}
              </div>
              {msg.role === "assistant" && (msg.latencyMs != null || msg.estimatedCost != null) && (
                <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                  {msg.latencyMs != null && <span>{(msg.latencyMs / 1000).toFixed(1)}s</span>}
                  {msg.estimatedCost != null && <span>${msg.estimatedCost.toFixed(4)}</span>}
                  {msg.model && <span className="opacity-60">{msg.model}</span>}
                </div>
              )}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {msg.toolCalls.map((tc, j) => (
                    <div key={j} className="text-[10px] font-mono text-muted-foreground">
                      <span className="text-success">tool:</span> {tc.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 mt-0.5">
                <User className="size-4 text-muted-foreground" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="flex items-center gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={loading}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground p-2 disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          <Send className="size-4" />
        </button>
      </form>
    </div>
  );
}
