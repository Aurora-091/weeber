import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { ValidationError } from "./errors";
import { errorHandler } from "../middleware/error-handler";

describe("Errors & Global Handler Integration", () => {
  it("ValidationError sets properties correctly", () => {
    const err = new ValidationError("Missing inputs", { field: "email" });
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe("VALIDATION_ERROR");
    expect(err.isOperational).toBe(true);
    expect(err.details).toEqual({ field: "email" });
  });

  it("Hono app handles operational ValidationError via global handler", async () => {
    const testApp = new Hono()
      .onError(errorHandler())
      .get("/test-validation", () => {
        throw new ValidationError("Invalid details provided", { field: "phone" });
      });

    const res = await testApp.request("/test-validation");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "Invalid details provided",
      code: "VALIDATION_ERROR",
      details: { field: "phone" }
    });
  });

  it("Hono app handles unexpected errors by logging and returning generic 500 error", async () => {
    const testApp = new Hono()
      .onError(errorHandler())
      .get("/test-crash", () => {
        throw new Error("Something exploded in the database");
      });

    const res = await testApp.request("/test-crash");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_SERVER_ERROR"
    });
  });
});
