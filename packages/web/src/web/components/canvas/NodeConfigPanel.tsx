import { useState } from "react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { NODE_STYLES } from "./node-styles";
import { WORKFLOW_OUTCOMES, MERGE_TAGS } from "./types";

function getMergeTags(vertical?: string): readonly string[] {
  return MERGE_TAGS[vertical || "shopify"] || MERGE_TAGS.default;
}
import type { WorkflowNodeType } from "./types";

type Props = {
  nodeId: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
};

export function NodeConfigPanel({ nodeId, nodeType, config, onUpdate }: Props) {
  const style = NODE_STYLES[nodeType];

  function set(key: string, value: unknown) {
    onUpdate({ ...config, [key]: value });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <div className={`w-1 h-5 rounded-full ${style.color}`} />
        <h3 className="text-sm font-medium">{style.label}</h3>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground truncate max-w-[100px]">
          {nodeId}
        </span>
      </div>

      {nodeType === "trigger" && <TriggerFields config={config} set={set} />}
      {nodeType === "wait" && <WaitFields config={config} set={set} />}
      {nodeType === "call" && <CallFields config={config} set={set} />}
      {nodeType === "conditionalSplit" && <SplitFields config={config} set={set} />}
      {nodeType === "sms" && <SmsFields config={config} set={set} />}
      {nodeType === "addToDnc" && <DncFields config={config} set={set} />}
      {nodeType === "webhook" && <WebhookFields config={config} set={set} />}
      {(nodeType === "dncCheck" || nodeType === "callingWindowCheck") && (
        <p className="text-xs text-muted-foreground">
          No configuration — this check runs automatically before any call or SMS reaches the
          customer, regardless of how the rest of the flow is wired.
        </p>
      )}
    </div>
  );
}

function TriggerFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label>Event</Label>
      <select
        value={(config.event as string) || "checkout_abandoned"}
        onChange={(e) => set("event", e.target.value)}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="checkout_abandoned">Checkout Abandoned</option>
        <option value="order_placed">Order Placed</option>
        <option value="order_fulfilled">Order Fulfilled</option>
      </select>
    </div>
  );
}

function WaitFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label>Delay (minutes)</Label>
      <Input
        type="number"
        min={1}
        value={Number(config.delayMinutes) || 60}
        max={10080}
        onChange={(e) => {
          const v = Number(e.target.value);
          set("delayMinutes", Math.max(1, Math.min(10080, Number.isFinite(v) ? v : 1)));
        }}
      />
      <p className="text-[10px] text-muted-foreground">
        = {((Number(config.delayMinutes) || 60) / 60).toFixed(1)} hours
      </p>
    </div>
  );
}

function CallFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const [mode, setMode] = useState<"flat" | "escalating">(
    typeof config.discountPercent === "object" ? "escalating" : "flat",
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label>Persona</Label>
        <Input
          value={(config.persona as string) || ""}
          onChange={(e) => set("persona", e.target.value)}
          placeholder="shopify-cart-recovery"
        />
      </div>

      <div className="grid gap-1.5">
        <Label>Discount mode</Label>
        <select
          value={mode}
          onChange={(e) => {
            const newMode = e.target.value as "flat" | "escalating";
            setMode(newMode);
            if (newMode === "flat") set("discountPercent", 0);
            else set("discountPercent", { "1": 0, "2": 10, "3": 20 });
          }}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="flat">Flat %</option>
          <option value="escalating">Escalating by attempt</option>
        </select>
      </div>

      {mode === "flat" && (
        <div className="grid gap-1.5">
          <Label>Discount %</Label>
          <Input
            type="number"
            min={0}
            max={30}
            value={typeof config.discountPercent === "number" ? config.discountPercent : 0}
            onChange={(e) => set("discountPercent", Number(e.target.value))}
          />
        </div>
      )}

      {mode === "escalating" && <EscalatingMap config={config} set={set} />}

      <div className="grid gap-1.5">
        <Label>Max duration (seconds)</Label>
        <Input
          type="number"
          min={30}
          value={Number(config.maxDurationSeconds) || ""}
          onChange={(e) => set("maxDurationSeconds", e.target.value ? Number(e.target.value) : undefined)}
          placeholder="Optional"
        />
      </div>
    </div>
  );
}

function EscalatingMap({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const map = (typeof config.discountPercent === "object" && config.discountPercent !== null
    ? config.discountPercent
    : { "1": 0 }) as Record<string, number>;

  function updateEntry(attempt: string, value: number) {
    set("discountPercent", { ...map, [attempt]: value });
  }

  function addEntry() {
    const keys = Object.keys(map).map(Number).filter((n) => Number.isFinite(n));
    const next = String(keys.length === 0 ? 1 : Math.max(...keys) + 1);
    set("discountPercent", { ...map, [next]: 0 });
  }

  function removeEntry(attempt: string) {
    const copy = { ...map };
    delete copy[attempt];
    set("discountPercent", copy);
  }

  return (
    <div className="space-y-2">
      <Label className="text-[10px]">Attempt → Discount %</Label>
      {Object.entries(map).map(([attempt, pct]) => (
        <div key={attempt} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-6">#{attempt}</span>
          <Input
            type="number"
            min={0}
            max={30}
            value={pct}
            onChange={(e) => updateEntry(attempt, Number(e.target.value))}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => removeEntry(attempt)}
            disabled={Object.keys(map).length <= 1}
            className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:pointer-events-none"
          >
            x
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addEntry}
        className="text-xs text-primary hover:underline"
      >
        + Add attempt
      </button>
    </div>
  );
}

function SplitFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const outcomes = (config.outcomes as string[]) || [];
  return (
    <div className="space-y-2">
      <Label>Active outcomes</Label>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {WORKFLOW_OUTCOMES.map((o) => (
          <label key={o} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={outcomes.includes(o)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...outcomes, o]
                  : outcomes.filter((x) => x !== o);
                set("outcomes", next);
              }}
            />
            {o}
          </label>
        ))}
      </div>
    </div>
  );
}

function SmsFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label>Template</Label>
        <textarea
          value={(config.template as string) || ""}
          onChange={(e) => set("template", e.target.value)}
          rows={4}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm resize-y"
          placeholder="Hi {{customer_name}}, your cart is waiting..."
        />
      </div>
      <div>
        <p className="text-[10px] font-medium text-muted-foreground mb-1">Available merge tags:</p>
        <div className="flex flex-wrap gap-1">
          {getMergeTags().map((tag) => (
            <span key={tag} className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">
              {`{{${tag}}}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function DncFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label>Reason</Label>
      <Input
        value={(config.reason as string) || ""}
        onChange={(e) => set("reason", e.target.value)}
        placeholder="cart recovery exhausted"
      />
    </div>
  );
}

function WebhookFields({ config, set }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const url = (config.url as string) || "";
  const isInvalid = url.length > 0 && !url.startsWith("https://") && !url.startsWith("http://");

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label>URL</Label>
        <Input
          type="url"
          value={url}
          onChange={(e) => set("url", e.target.value)}
          placeholder="https://hooks.example.com/..."
          className={isInvalid ? "border-destructive" : ""}
        />
        {isInvalid && (
          <p className="text-[10px] text-destructive">URL must start with https:// or http://</p>
        )}
      </div>
    </div>
  );
}
