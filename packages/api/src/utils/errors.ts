export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "COMPLIANCE_BLOCKED"
  | "INTEGRATION_FAILED"
  | "INTERNAL_SERVER_ERROR";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: any;

  constructor(message: string, statusCode: number, errorCode: ErrorCode, isOperational = true, details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 400, "VALIDATION_ERROR", true, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized access") {
    super(message, 401, "UNAUTHORIZED", true);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Access forbidden") {
    super(message, 403, "FORBIDDEN", true);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND", true);
  }
}

export class ComplianceError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 403, "COMPLIANCE_BLOCKED", true, details);
  }
}

export class IntegrationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 502, "INTEGRATION_FAILED", true, details);
  }
}

export class InternalError extends AppError {
  constructor(message: string = "An unexpected error occurred", details?: any) {
    super(message, 500, "INTERNAL_SERVER_ERROR", false, details);
  }
}
