export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'bad_request', message, details);
}

export function unauthorized(message = 'Missing or invalid token'): AppError {
  return new AppError(401, 'unauthorized', message);
}

export function forbidden(message = 'You do not have access to this resource'): AppError {
  return new AppError(403, 'forbidden', message);
}

export function notFound(kind: string, ref: string): AppError {
  return new AppError(404, 'not_found', `${kind} "${ref}" not found`);
}

export function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(409, code, message, details);
}

export function payloadTooLarge(message = 'File exceeds the allowed size'): AppError {
  return new AppError(413, 'payload_too_large', message);
}
