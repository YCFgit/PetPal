export class DomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function invalid(message: string): never {
  throw new DomainError('INVALID_REQUEST', message, 400);
}

export function notFound(): never {
  throw new DomainError('NOT_FOUND', 'Resource not found', 404);
}

export function conflict(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('A JSON object is required');
  }
  return value as Record<string, unknown>;
}

export function onlyFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) invalid('Unexpected request field');
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    return invalid(`${field} must be a valid identifier`);
  }
  return value;
}
