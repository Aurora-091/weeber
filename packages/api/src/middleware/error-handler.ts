import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

export const errorHandler = (): ErrorHandler => {
  return async (err, c) => {
    // Check if it's our custom AppError class
    if (err instanceof AppError) {
      if (err.isOperational) {
        logger.warn(`Operational error: ${err.message}`, err);
        return c.json(
          {
            error: err.message,
            code: err.errorCode,
            details: err.details,
          },
          err.statusCode as any
        );
      } else {
        logger.error(`Non-operational AppError: ${err.message}`, err);
        return c.json(
          {
            error: "Internal Server Error",
            code: "INTERNAL_SERVER_ERROR",
          },
          500
        );
      }
    }

    // Check if it is a standard Hono HTTPException
    if (err instanceof HTTPException) {
      logger.warn(`HTTPException: ${err.message} (status: ${err.status})`);
      return c.json(
        {
          error: err.message,
          code: "HTTP_EXCEPTION",
        },
        err.status
      );
    }

    // Unexpected general exception
    logger.error(`Unhandled system exception: ${err.message}`, err);
    return c.json(
      {
        error: "Internal Server Error",
        code: "INTERNAL_SERVER_ERROR",
      },
      500
    );
  };
};
