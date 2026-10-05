/**
 * Errors that route handlers and services throw to produce a specific 4xx response.
 * The app's error handler turns them into `{ error: code, message }`.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, 'not_found', `${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, 'bad_request', message);
    this.name = 'ValidationError';
  }
}
