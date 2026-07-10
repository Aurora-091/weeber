import { type Logger } from "drizzle-orm";
import { logger } from "../utils/logger";

export class DrizzleLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    logger.debug(`SQL: ${query}`, { params });
  }
}
