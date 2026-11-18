/**
 * Error de negocio con código estable. El cliente Android debe decidir por
 * `code` (no por `message`, que es texto para mostrar al usuario).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'No autenticado', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);

export const forbidden = (message = 'No tienes permiso para esta acción', code = 'FORBIDDEN') =>
  new AppError(403, code, message);

export const notFound = (message = 'Recurso no encontrado', code = 'NOT_FOUND') =>
  new AppError(404, code, message);

export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);
