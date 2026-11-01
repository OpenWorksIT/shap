export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'error',
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'Please sign in') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, msg, 'forbidden');
export const notFound = (what = 'Item') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);
