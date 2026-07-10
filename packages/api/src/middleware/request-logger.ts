import type { MiddlewareHandler } from "hono";
import { logContext, logger } from "../utils/logger";

export const requestLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const reqId = crypto.randomUUID();
    const startTime = performance.now();

    c.header("X-Request-ID", reqId);

    await logContext.run({ reqId }, async () => {
      logger.info(`Incoming request ${c.req.method} ${c.req.path}`);

      await next();

      const duration = (performance.now() - startTime).toFixed(2);
      logger.info(`Outgoing response ${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`);
    });
  };
};
