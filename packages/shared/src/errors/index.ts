export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const ErrorCodes = {
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',

  // Resources
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Business Logic
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  EXPERT_NOT_AVAILABLE: 'EXPERT_NOT_AVAILABLE',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',

  // External Services
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  CALENDAR_SYNC_FAILED: 'CALENDAR_SYNC_FAILED',

  // Internal
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function createNotFoundError(resource: string): AppError {
  return new AppError(ErrorCodes.NOT_FOUND, `${resource} not found`, 404);
}

export function createUnauthorizedError(message = 'Unauthorized'): AppError {
  return new AppError(ErrorCodes.UNAUTHORIZED, message, 401);
}

export function createForbiddenError(message = 'Forbidden'): AppError {
  return new AppError(ErrorCodes.FORBIDDEN, message, 403);
}

export function createValidationError(details: unknown): AppError {
  return new AppError(ErrorCodes.VALIDATION_ERROR, 'Validation failed', 400, details);
}
