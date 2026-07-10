import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogContext {
  reqId?: string;
  [key: string]: any;
}

// Storage for request-scoped correlation ID and metadata
export const logContext = new AsyncLocalStorage<LogContext>();

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function getLevelColor(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "\x1b[36m"; // Cyan
    case "info":
      return "\x1b[32m"; // Green
    case "warn":
      return "\x1b[33m"; // Yellow
    case "error":
      return "\x1b[31m"; // Red
    case "fatal":
      return "\x1b[35m"; // Magenta
    default:
      return "";
  }
}

const RESET_COLOR = "\x1b[0m";

function formatObject(obj: any): string {
  if (obj instanceof Error) {
    return `${obj.name}: ${obj.message}\n${obj.stack ?? ""}`;
  }
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
  } catch {
    return String(obj);
  }
}

function writeLog(level: LogLevel, message: string, meta?: any) {
  const currentEnv = process.env.NODE_ENV || "development";
  const logFormat = process.env.LOG_FORMAT || (currentEnv === "production" ? "json" : "console");

  const contextStore = logContext.getStore() || {};
  const reqId = contextStore.reqId;

  if (logFormat === "json") {
    // Structured JSON logging
    const logObj: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      reqId,
    };
    if (meta !== undefined) {
      if (meta instanceof Error) {
        logObj.error = {
          name: meta.name,
          message: meta.message,
          stack: meta.stack,
        };
      } else if (typeof meta === "object" && meta !== null) {
        Object.assign(logObj, meta);
      } else {
        logObj.meta = meta;
      }
    }
    console.log(JSON.stringify(logObj));
  } else {
    // Colorized human-readable console logging
    const time = new Date().toLocaleTimeString();
    const color = getLevelColor(level);
    const reqStr = reqId ? ` [reqId=${reqId}]` : "";
    const metaStr = meta !== undefined ? ` ${formatObject(meta)}` : "";
    console.log(`[${time}] ${color}${level.toUpperCase()}${RESET_COLOR}:${reqStr} ${message}${metaStr}`);
  }
}

function getMinLevel(): LogLevel {
  const rawLevel = process.env.LOG_LEVEL;
  if (rawLevel && rawLevel in LEVEL_SEVERITY) {
    return rawLevel as LogLevel;
  }
  return "info";
}

export const logger = {
  debug(msg: string, meta?: any) {
    if (LEVEL_SEVERITY.debug >= LEVEL_SEVERITY[getMinLevel()]) {
      writeLog("debug", msg, meta);
    }
  },
  info(msg: string, meta?: any) {
    if (LEVEL_SEVERITY.info >= LEVEL_SEVERITY[getMinLevel()]) {
      writeLog("info", msg, meta);
    }
  },
  warn(msg: string, meta?: any) {
    if (LEVEL_SEVERITY.warn >= LEVEL_SEVERITY[getMinLevel()]) {
      writeLog("warn", msg, meta);
    }
  },
  error(msg: string, meta?: any) {
    if (LEVEL_SEVERITY.error >= LEVEL_SEVERITY[getMinLevel()]) {
      writeLog("error", msg, meta);
    }
  },
  fatal(msg: string, meta?: any) {
    if (LEVEL_SEVERITY.fatal >= LEVEL_SEVERITY[getMinLevel()]) {
      writeLog("fatal", msg, meta);
    }
  },
};
