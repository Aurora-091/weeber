import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";

afterEach(cleanup);

describe("Card", () => {
  it("renders with default slot and variant attributes", () => {
    render(
      <Card data-testid="test-card">
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card Description</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Main content area</p>
        </CardContent>
        <CardFooter>
          <button type="button">Action</button>
        </CardFooter>
      </Card>,
    );

    const card = screen.getByTestId("test-card");
    expect(card.getAttribute("data-slot")).toBe("card");
    expect(card.getAttribute("data-variant")).toBe("default");
    expect(screen.getByText("Card Title").getAttribute("data-slot")).toBe("card-title");
    expect(screen.getByText("Card Description").getAttribute("data-slot")).toBe("card-description");
  });

  it("supports interactive and editor variants", () => {
    const { rerender } = render(<Card data-testid="variant-card" variant="interactive" />);
    let card = screen.getByTestId("variant-card");
    expect(card.getAttribute("data-variant")).toBe("interactive");
    expect(card.className).toContain("cursor-pointer");

    rerender(<Card data-testid="variant-card" variant="editor" />);
    card = screen.getByTestId("variant-card");
    expect(card.getAttribute("data-variant")).toBe("editor");
    expect(card.className).toContain("backdrop-blur-md");
  });
});
