import { describe, expect, test } from "bun:test";
import { parseEventBatch, MAX_EVENTS_PER_BATCH, MAX_PROPS_BYTES } from "./events-ingest";

describe("parseEventBatch", () => {
  test("accepts a well-formed event (both body shapes)", () => {
    const wrapped = parseEventBatch({ events: [{ name: "workflow_list_viewed", props: { a: 1 } }] });
    expect(wrapped.valid).toHaveLength(1);
    expect(wrapped.rejected).toBe(0);
    expect(wrapped.valid[0]!.name).toBe("workflow_list_viewed");
    expect(wrapped.valid[0]!.props).toEqual({ a: 1 });

    const bare = parseEventBatch([{ name: "workflow_activated" }]);
    expect(bare.valid).toHaveLength(1);
  });

  test("rejects malformed names", () => {
    const r = parseEventBatch({
      events: [
        { name: "Workflow_Bad" }, // uppercase
        { name: "ab" }, // too short (<3)
        { name: "1leading" }, // must start with letter
        { name: "has space" },
        { name: "" },
        { name: 123 }, // not a string
        { name: "a".repeat(65) }, // too long
      ],
    });
    expect(r.valid).toHaveLength(0);
    expect(r.rejected).toBe(7);
  });

  test("drops non-object entries but keeps valid ones", () => {
    const r = parseEventBatch({ events: [null, "x", 5, { name: "workflow_paused" }] });
    expect(r.valid.map((e) => e.name)).toEqual(["workflow_paused"]);
    expect(r.rejected).toBe(3);
  });

  test("nulls out oversized / non-serializable props but keeps the event", () => {
    const big = { blob: "x".repeat(MAX_PROPS_BYTES + 100) };
    const r = parseEventBatch({ events: [{ name: "workflow_save_succeeded", props: big }] });
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.props).toBeNull();
  });

  test("nulls out array props (props must be a plain object)", () => {
    const r = parseEventBatch({ events: [{ name: "workflow_node_added", props: [1, 2, 3] }] });
    expect(r.valid[0]!.props).toBeNull();
  });

  test("caps the batch at MAX_EVENTS_PER_BATCH and counts the overflow as rejected", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 10 }, () => ({ name: "workflow_edge_connected" }));
    const r = parseEventBatch({ events });
    expect(r.valid).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(r.rejected).toBe(10);
  });

  test("parses a valid epoch-ms timestamp and rejects junk / skewed clocks", () => {
    const now = Date.now();
    const ok = parseEventBatch({ events: [{ name: "workflow_activated", ts: now }] });
    expect(ok.valid[0]!.occurredAt).toBeInstanceOf(Date);

    const future = parseEventBatch({ events: [{ name: "workflow_activated", ts: now + 10 * 60_000 }] });
    expect(future.valid[0]!.occurredAt).toBeNull();

    const stale = parseEventBatch({ events: [{ name: "workflow_activated", ts: now - 2 * 60 * 60_000 }] });
    expect(stale.valid[0]!.occurredAt).toBeNull();

    const junk = parseEventBatch({ events: [{ name: "workflow_activated", ts: "yesterday" }] });
    expect(junk.valid[0]!.occurredAt).toBeNull();
  });

  test("truncates over-long sessionId / path and trims blanks to null", () => {
    const r = parseEventBatch({
      events: [{ name: "workflow_list_viewed", sessionId: "s".repeat(500), path: "   " }],
    });
    expect(r.valid[0]!.sessionId!.length).toBe(256);
    expect(r.valid[0]!.path).toBeNull();
  });

  test("returns empty for garbage bodies", () => {
    expect(parseEventBatch(null).valid).toHaveLength(0);
    expect(parseEventBatch({}).valid).toHaveLength(0);
    expect(parseEventBatch("nope").valid).toHaveLength(0);
    expect(parseEventBatch(42).valid).toHaveLength(0);
  });
});
