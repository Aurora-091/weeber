import { describe, it, expect } from "bun:test";
import { getAllowedOrigins, assertCorsConfiguredForProduction, buildCorsOriginResolver } from "./cors-config";

/**
 * Audit 2026-07-19 finding #3: CORS reflected any origin (with credentials: true) whenever
 * CORS_ALLOWED_ORIGINS was unset, in every environment including production. Fixed: unset in
 * production now refuses to boot; unset elsewhere (dev/test/CI) is unchanged so local dev needs
 * zero extra config. Extracted into its own module so this is testable without importing the
 * whole app entrypoint (index.ts pulls in the full route tree).
 */

describe("getAllowedOrigins", () => {
  it("parses a comma-separated allowlist, trimming whitespace", () => {
    const env = { CORS_ALLOWED_ORIGINS: " https://a.example , https://b.example" } as NodeJS.ProcessEnv;
    expect(getAllowedOrigins(env)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("returns an empty array when unset", () => {
    expect(getAllowedOrigins({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("filters out empty entries from trailing/leading commas", () => {
    const env = { CORS_ALLOWED_ORIGINS: "https://a.example,,https://b.example," } as NodeJS.ProcessEnv;
    expect(getAllowedOrigins(env)).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("assertCorsConfiguredForProduction", () => {
  it("throws when NODE_ENV=production and CORS_ALLOWED_ORIGINS is unset", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => assertCorsConfiguredForProduction(env)).toThrow(/CORS_ALLOWED_ORIGINS must be set/);
  });

  it("does not throw when NODE_ENV=production and CORS_ALLOWED_ORIGINS is set", () => {
    const env = { NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "https://app.weeber.ai" } as NodeJS.ProcessEnv;
    expect(() => assertCorsConfiguredForProduction(env)).not.toThrow();
  });

  it("does not throw in development/test even when unset", () => {
    expect(() => assertCorsConfiguredForProduction({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertCorsConfiguredForProduction({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertCorsConfiguredForProduction({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("buildCorsOriginResolver", () => {
  it("reflects any origin when no allowlist is configured", () => {
    const resolve = buildCorsOriginResolver({} as NodeJS.ProcessEnv);
    expect(resolve("https://anything.example")).toBe("https://anything.example");
    expect(resolve(undefined)).toBe("*");
  });

  it("only allows origins present in the allowlist when one is configured", () => {
    const env = { CORS_ALLOWED_ORIGINS: "https://app.weeber.ai,https://admin.weeber.ai" } as NodeJS.ProcessEnv;
    const resolve = buildCorsOriginResolver(env);
    expect(resolve("https://app.weeber.ai")).toBe("https://app.weeber.ai");
    expect(resolve("https://evil.example")).toBeNull();
    expect(resolve(undefined)).toBeNull();
  });
});
