import { describe, expect, it } from "bun:test";

import { describeMigrationError } from "./migration-error";

/**
 * The bug these tests guard (ADR-076): the deploy start path ran
 * `bunx drizzle-kit migrate`, which on failure printed nothing but a cleared
 * spinner line and exited 1, crash-looping the container with no diagnostic.
 * The replacement runner is only an improvement if it actually surfaces the
 * Postgres error — and drizzle-orm hides that error one level down, on
 * `.cause`, so a formatter that stops at the top-level Error reproduces the
 * original "which statement, but not why" blindness.
 */
describe("describeMigrationError", () => {
  it("surfaces the Postgres error hidden on .cause, not just the failing SQL", () => {
    const pgError = Object.assign(new Error('permission denied for schema "drizzle"'), {
      name: "PostgresError",
      severity: "ERROR",
      code: "42501",
      routine: "aclcheck_error",
    });
    const wrapped = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', {
      cause: pgError,
    });

    const output = describeMigrationError(wrapped);

    // the outer error tells you the statement...
    expect(output).toContain('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"');
    // ...and the chain has to be walked to learn why it died
    expect(output).toContain("caused by:");
    expect(output).toContain("code: 42501");
    expect(output).toContain("severity: ERROR");
    expect(output).toContain("routine: aclcheck_error");
    expect(output).toContain('permission denied for schema "drizzle"');
  });

  it("reports connection-level failures that carry errno/syscall instead of a pg code", () => {
    const connError = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6543"), {
      errno: -111,
      syscall: "connect",
      address: "10.0.0.1",
      port: 6543,
    });

    const output = describeMigrationError(connError);

    expect(output).toContain("syscall: connect");
    expect(output).toContain("address: 10.0.0.1");
    expect(output).toContain("port: 6543");
  });

  it("omits fields that are absent, null or empty rather than printing noise", () => {
    const error = Object.assign(new Error("boom"), { detail: "", hint: null, code: undefined });

    const output = describeMigrationError(error);

    expect(output).toContain("message: boom");
    expect(output).not.toContain("detail:");
    expect(output).not.toContain("hint:");
    expect(output).not.toContain("code:");
  });

  it("stops walking a cyclic cause chain instead of recursing forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const output = describeMigrationError(a);

    // depth cap kicks in; the point is that it returns at all
    expect(output.split("caused by:").length - 1).toBeLessThanOrEqual(5);
  });

  it("describes a thrown non-Error without crashing", () => {
    expect(describeMigrationError("just a string")).toContain("non-Error thrown: just a string");
    expect(describeMigrationError(undefined)).toContain("non-Error thrown: undefined");
  });
});
