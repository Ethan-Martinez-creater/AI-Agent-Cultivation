export type AvailabilityFailureKind = 'HARD_FAILURE' | 'TRANSIENT_FAILURE';

export interface AvailabilityFailureClassification {
  kind: AvailabilityFailureKind;
  code: string;
}

const hardHttpStatuses = new Set([400, 401, 403, 404, 422]);

const hardFailureCodes = new Set([
  'NOT_FOUND',
  'INVALID_INPUT',
  'UNSUPPORTED_PROVIDER',
  'ERR_INVALID_URL',
  'ECONNREFUSED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const transientFailureCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findNumericStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = asRecord(current);
    if (!record) return null;
    for (const key of ['statusCode', 'status']) {
      if (typeof record[key] === 'number' && Number.isInteger(record[key])) {
        return record[key] as number;
      }
    }
    current = record.cause;
  }
  return null;
}

function findSafeErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = asRecord(current);
    if (!record) return null;
    if (typeof record.code === 'string') return record.code.toUpperCase();
    current = record.cause;
  }
  return null;
}

function findErrorName(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = asRecord(current);
    if (!record) return null;
    if (typeof record.name === 'string') return record.name;
    current = record.cause;
  }
  return null;
}

/** Classifies provider SDK/transport errors without retaining or exposing their payloads. */
export function classifyProviderError(error: unknown): AvailabilityFailureClassification {
  const status = findNumericStatus(error);
  if (status !== null) return classifyHttpFailure(status);

  const code = findSafeErrorCode(error);
  if (code && hardFailureCodes.has(code)) {
    return {
      kind: 'HARD_FAILURE',
      code: code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'PROVIDER_REJECTED_REQUEST',
    };
  }
  if (code && transientFailureCodes.has(code)) {
    return {
      kind: 'TRANSIENT_FAILURE',
      code: code.includes('TIMEOUT') ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
    };
  }

  const name = findErrorName(error);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'TRANSIENT_FAILURE', code: 'REQUEST_TIMEOUT' };
  }

  return { kind: 'TRANSIENT_FAILURE', code: 'PROVIDER_TEMPORARY_FAILURE' };
}

export function classifyHttpFailure(status: number): AvailabilityFailureClassification {
  if (hardHttpStatuses.has(status)) {
    return {
      kind: 'HARD_FAILURE',
      code:
        status === 401 || status === 403
          ? 'AUTHENTICATION_REJECTED'
          : status === 404
            ? 'MODEL_NOT_FOUND'
            : 'PROVIDER_REJECTED_REQUEST',
    };
  }
  return {
    kind: 'TRANSIENT_FAILURE',
    code: status === 429 ? 'RATE_LIMITED' : 'PROVIDER_TEMPORARY_FAILURE',
  };
}
