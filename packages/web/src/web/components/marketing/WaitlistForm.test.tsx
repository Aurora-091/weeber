import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WaitlistForm } from "./WaitlistForm";

// Closes the biggest packages/web coverage gap: the marketing waitlist form —
// the single most important conversion surface on the site — had no test at all.
// These assert the CLIENT-SIDE contract only (render + validation gating), which
// needs no live backend, so they stay deterministic in CI. `useWaitlistCount`
// fires a fetch on mount, so we stub global.fetch to a harmless success.
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

// `useWaitlistCount` opens a live WebSocket to the API for the real-time count.
// In a unit test there's no server, so a real socket just emits an unhandled
// error (false-red in CI). Swap in an inert fake that never connects or errors.
class InertWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

// happy-dom registers some globals (fetch/WebSocket) as non-writable, so a plain
// `globalThis.x = ...` assignment throws "readonly property" once another test
// file has run first. defineProperty(configurable) sidesteps that reliably.
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  setGlobal("fetch", async () =>
    new Response(JSON.stringify({ count: 43 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  setGlobal("WebSocket", InertWebSocket);
});

afterEach(() => {
  setGlobal("fetch", realFetch);
  setGlobal("WebSocket", realWebSocket);
  cleanup();
});

describe("WaitlistForm", () => {
  it("renders the name + email fields and the CTA", () => {
    render(<WaitlistForm />);
    expect(screen.getByLabelText("Your name")).toBeDefined();
    expect(screen.getByLabelText("Business email")).toBeDefined();
    expect(screen.getByRole("button", { name: "Get early access" })).toBeDefined();
  });

  it("disables submit until name + a valid email are entered", () => {
    render(<WaitlistForm />);
    const submit = screen.getByRole("button", { name: "Get early access" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Rushikesh" } });
    fireEvent.change(screen.getByLabelText("Business email"), { target: { value: "not-an-email" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Business email"), { target: { value: "r@weeber.ai" } });
    expect(submit.disabled).toBe(false);
  });

  it("shows an inline error for an invalid email once touched", () => {
    render(<WaitlistForm />);
    const email = screen.getByLabelText("Business email");
    fireEvent.change(email, { target: { value: "bad@" } });
    fireEvent.blur(email);
    expect(screen.getByText("Please enter a valid email address.")).toBeDefined();
    expect(email.getAttribute("aria-invalid")).toBe("true");
  });
});
