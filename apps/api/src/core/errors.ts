export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, 'bad_request', details);
export const unauthenticated = () => new AppError(401, 'Please sign in.', 'unauthenticated');
export const forbidden = (message = 'You don\'t have access to this.') => new AppError(403, message, 'forbidden');
export const notFound = (what = 'Record') => new AppError(404, `${what} not found.`, 'not_found');
export const conflict = (message: string) => new AppError(409, message, 'conflict');
