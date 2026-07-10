import { describe, it, expect, spyOn, afterEach, beforeEach } from "bun:test";
import { logger, logContext } from "./logger";

describe("Logger", () => {
  let logSpy: any;
  let originalEnv: string | undefined;
  let originalFormat: string | undefined;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    originalEnv = process.env.NODE_ENV;
    originalFormat = process.env.LOG_FORMAT;
    originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
    process.env.LOG_FORMAT = originalFormat;
    process.env.LOG_LEVEL = originalLogLevel;
  });

  it("prints console-formatted log in development", () => {
    process.env.LOG_FORMAT = "console";
    logger.info("Hello world");

    expect(logSpy).toHaveBeenCalled();
    const loggedText = logSpy.mock.calls[0][0];
    expect(loggedText).toContain("INFO");
    expect(loggedText).toContain("Hello world");
  });

  it("prints JSON-formatted log in production", () => {
    process.env.LOG_FORMAT = "json";
    logger.info("Structured log message", { key: "value" });

    expect(logSpy).toHaveBeenCalled();
    const loggedJson = JSON.parse(logSpy.mock.calls[0][0]);
    expect(loggedJson.level).toBe("info");
    expect(loggedJson.message).toBe("Structured log message");
    expect(loggedJson.key).toBe("value");
    expect(loggedJson.timestamp).toBeDefined();
  });

  it("attaches reqId correlation context via AsyncLocalStorage", () => {
    process.env.LOG_FORMAT = "json";

    logContext.run({ reqId: "test-correlation-id" }, () => {
      logger.info("Action inside request context");
    });

    expect(logSpy).toHaveBeenCalled();
    const loggedJson = JSON.parse(logSpy.mock.calls[0][0]);
    expect(loggedJson.message).toBe("Action inside request context");
    expect(loggedJson.reqId).toBe("test-correlation-id");
  });
});
