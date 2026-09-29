import Database from 'better-sqlite3';

export type R2ExternalWorkContinuationState = 'PENDING' | 'CONSUMING' | 'CONSUMED';

export interface R2ExternalWorkContinuation {
  externalWorkRequestId: string;
  missionId: string;
  missionRunId: string;
  state: R2ExternalWorkContinuationState;
  createdAt: string;
  updatedAt: string;
  consumedAt: string | null;
}

export interface CreateR2ExternalWorkContinuationInput {
  externalWorkRequestId: string;
  missionId: string;
  missionRunId: string;
  createdAt: string;
}

interface R2ExternalWorkContinuationRow {
  external_work_request_id: string;
  mission_id: string;
  mission_run_id: string;
  state: R2ExternalWorkContinuationState;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
}

const MAX_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 128;

/** Durable, Run-bound acceptance continuation for R2 ExternalWork. */
export class R2ContinuationRepository {
  constructor(private readonly db: Database.Database) {}

  createPending(input: CreateR2ExternalWorkContinuationInput): R2ExternalWorkContinuation {
    validateInput(input);
    this.db
      .prepare(
        `INSERT INTO r2_external_work_continuations
          (external_work_request_id, mission_id, mission_run_id, state, created_at, updated_at, consumed_at)
         VALUES (@externalWorkRequestId, @missionId, @missionRunId, 'PENDING', @createdAt, @createdAt, NULL)
         ON CONFLICT(external_work_request_id) DO NOTHING`,
      )
      .run(input);
    const continuation = this.getByRequestId(input.externalWorkRequestId);
    if (
      !continuation ||
      continuation.missionId !== input.missionId ||
      continuation.missionRunId !== input.missionRunId
    ) {
      throw new Error('ExternalWork continuation identity conflicts with the accepted request');
    }
    return continuation;
  }

  getByRequestId(requestId: string): R2ExternalWorkContinuation | null {
    validateId(requestId, 'ExternalWork request');
    const row = this.db
      .prepare('SELECT * FROM r2_external_work_continuations WHERE external_work_request_id = ?')
      .get(requestId) as R2ExternalWorkContinuationRow | undefined;
    return row ? mapContinuation(row) : null;
  }

  /** Returns unconsumed rows in deterministic startup order. */
  listRecoverable(): R2ExternalWorkContinuation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM r2_external_work_continuations
         WHERE state IN ('PENDING', 'CONSUMING')
         ORDER BY created_at, external_work_request_id`,
      )
      .all() as R2ExternalWorkContinuationRow[];
    return rows.map(mapContinuation);
  }

  /** Claims a pending continuation. A false result means another caller already claimed it. */
  markConsuming(requestId: string, at: string): boolean {
    validateId(requestId, 'ExternalWork request');
    validateTimestamp(at);
    return (
      this.db
        .prepare(
          `UPDATE r2_external_work_continuations
           SET state = 'CONSUMING', updated_at = ?
           WHERE external_work_request_id = ? AND state = 'PENDING'`,
        )
        .run(at, requestId).changes === 1
    );
  }

  /** Completes consumption idempotently after the coordinator result is durable. */
  markConsumed(requestId: string, at: string): boolean {
    validateId(requestId, 'ExternalWork request');
    validateTimestamp(at);
    const current = this.getByRequestId(requestId);
    if (!current) return false;
    if (current.state === 'CONSUMED') return true;
    if (current.state !== 'CONSUMING') return false;
    return (
      this.db
        .prepare(
          `UPDATE r2_external_work_continuations
           SET state = 'CONSUMED', updated_at = ?, consumed_at = ?
           WHERE external_work_request_id = ? AND state = 'CONSUMING'`,
        )
        .run(at, at, requestId).changes === 1
    );
  }
}

function mapContinuation(row: R2ExternalWorkContinuationRow): R2ExternalWorkContinuation {
  return {
    externalWorkRequestId: row.external_work_request_id,
    missionId: row.mission_id,
    missionRunId: row.mission_run_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
  };
}

function validateInput(input: CreateR2ExternalWorkContinuationInput): void {
  validateId(input.externalWorkRequestId, 'ExternalWork request');
  validateId(input.missionId, 'Mission');
  validateId(input.missionRunId, 'Mission Run');
  validateTimestamp(input.createdAt);
}

function validateId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_ID_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label} id`);
  }
}

function validateTimestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error('Invalid ExternalWork continuation timestamp');
  }
}
