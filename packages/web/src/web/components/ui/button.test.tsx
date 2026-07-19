import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./button";

// Smoke-level component tests: prove the happy-dom + testing-library harness
// works (this is the reference pattern for future web component tests) and
// that Button's core contract holds — renders children, applies variant/size
// data-slots, fires onClick, and blocks clicks when disabled.
afterEach(cleanup);

describe("Button", () => {
  it("renders its children as a native button by default", () => {
    render(<Button>Get early access</Button>);
    const btn = screen.getByRole("button", { name: "Get early access" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("data-slot")).toBe("button");
  });

  it("reflects variant and size on data-attributes", () => {
    render(
      <Button variant="destructive" size="lg">
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.getAttribute("data-variant")).toBe("destructive");
    expect(btn.getAttribute("data-size")).toBe("lg");
  });

  it("fires onClick when enabled", () => {
    let clicks = 0;
    render(<Button onClick={() => clicks++}>Click me</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Click me" }));
    expect(clicks).toBe(1);
  });

  it("does not fire onClick when disabled", () => {
    let clicks = 0;
    render(
      <Button disabled onClick={() => clicks++}>
        Nope
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nope" }));
    expect(clicks).toBe(0);
  });
});
