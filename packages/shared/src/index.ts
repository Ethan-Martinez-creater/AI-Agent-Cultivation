export type Id = string;
export type IsoDateTime = string;

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class DomainError extends Error implements AppError {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = false;
    this.details = details;
  }
}
