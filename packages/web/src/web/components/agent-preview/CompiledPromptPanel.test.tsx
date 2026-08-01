import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CompiledPromptPanel, type PromptSegment } from "./CompiledPromptPanel";

afterEach(cleanup);

function segments(callControlBody: string): PromptSegment[] {
  return [
    { id: "language", label: "Language behaviour", source: "From your Language setting.", body: "", editable: false },
    { id: "identity", label: "Identity & tone", source: "From name and tone.", body: "Your name is Aria.\n\n", editable: false },
    { id: "persona", label: "Your instructions", source: "The prompt you wrote.", body: "Help customers.", editable: true },
    { id: "disclosure", label: "Recording disclosure", source: "Compliance requirement.", body: "\n\nSay this: recorded.", editable: false },
    { id: "call-control", label: "Call control & guardrails", source: "From tools and guardrails.", body: callControlBody, editable: false },
  ];
}

function respondWith(callControlBody: string) {
  const segs = segments(callControlBody);
  return new Response(JSON.stringify({ text: segs.map((s) => s.body).join(""), segments: segs }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Phase III / D2 (ADR-067). These cover the two claims the panel makes to a
 * merchant — "these are the layers you ship" and "this is what your last edit
 * changed" — without booting a server: the segments are backend-supplied, so
 * a stubbed fetch is a faithful stand-in.
 */
describe("CompiledPromptPanel", () => {
  it("renders every layer the backend returned, including the ones the merchant never sees otherwise", async () => {
    render(
      <CompiledPromptPanel fetchFn={async () => respondWith("- Call hangUp when done.")} configKey="a" />,
    );
    await waitFor(() => expect(screen.getByText("Your instructions")).toBeTruthy());
    expect(screen.getByText("Identity & tone")).toBeTruthy();
    expect(screen.getByText("Recording disclosure")).toBeTruthy();
    expect(screen.getByText("Call control & guardrails")).toBeTruthy();
    expect(screen.getByText("Language behaviour")).toBeTruthy();
  });

  it("marks the merchant's own layer as theirs and shows it expanded by default", async () => {
    render(<CompiledPromptPanel fetchFn={async () => respondWith("- x")} configKey="a" />);
    await waitFor(() => expect(screen.getByText("yours")).toBeTruthy());
    // The editable layer's body is visible without a click; the others are collapsed.
    expect(screen.getByText("Help customers.")).toBeTruthy();
    expect(screen.queryByText("Your name is Aria.")).toBeNull();
  });

  it("labels a layer that resolved to nothing as 'not applied' rather than hiding it", async () => {
    render(<CompiledPromptPanel fetchFn={async () => respondWith("- x")} configKey="a" />);
    await waitFor(() => expect(screen.getByText("not applied")).toBeTruthy());
  });

  it("expands a collapsed layer on click", async () => {
    render(<CompiledPromptPanel fetchFn={async () => respondWith("- x")} configKey="a" />);
    await waitFor(() => expect(screen.getByText("Identity & tone")).toBeTruthy());
    fireEvent.click(screen.getByText("Identity & tone"));
    await waitFor(() => expect(screen.getByText("Your name is Aria.")).toBeTruthy());
  });

  it("shows which instruction lines appeared and disappeared after a config change", async () => {
    let body = "- Call hangUp when done.\n- Transfer to a human on request.";
    const { rerender } = render(
      <CompiledPromptPanel fetchFn={async () => respondWith(body)} configKey="tools-a" />,
    );
    await waitFor(() => expect(screen.getByText("Call control & guardrails")).toBeTruthy());

    // Merchant unticks "Transfer to a person": one bullet goes, one arrives.
    body = "- Call hangUp when done.\n- There's no live transfer available on this call.";
    rerender(<CompiledPromptPanel fetchFn={async () => respondWith(body)} configKey="tools-b" />);

    await waitFor(() => expect(screen.getByText("just changed")).toBeTruthy());
    expect(screen.getByText("− - Transfer to a human on request.")).toBeTruthy();
    expect(screen.getByText("+ - There's no live transfer available on this call.")).toBeTruthy();
  });

  it("does not claim anything changed on the very first compile", async () => {
    render(<CompiledPromptPanel fetchFn={async () => respondWith("- x")} configKey="a" />);
    await waitFor(() => expect(screen.getByText("Your instructions")).toBeTruthy());
    expect(screen.queryByText("just changed")).toBeNull();
  });

  it("surfaces the backend's error instead of rendering an empty prompt", async () => {
    render(
      <CompiledPromptPanel
        fetchFn={async () =>
          new Response(JSON.stringify({ error: "Invalid configOverride" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        }
        configKey="a"
      />,
    );
    await waitFor(() => expect(screen.getByText("Invalid configOverride")).toBeTruthy());
  });

  it("says out loud that a real call gets more than this — the per-call blocks it cannot show yet", async () => {
    render(<CompiledPromptPanel fetchFn={async () => respondWith("- x")} configKey="a" />);
    await waitFor(() => expect(screen.getByText(/characters total/)).toBeTruthy());
    expect(screen.getByText(/memory of previous calls/)).toBeTruthy();
  });
});
