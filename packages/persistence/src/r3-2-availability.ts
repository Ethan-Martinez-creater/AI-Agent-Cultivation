import Database from 'better-sqlite3';
import type {
  AvailabilityOutcome,
  ModelAvailabilityProjection,
  ModelAvailabilityStatus,
} from '@cultivation/domain';

export const MAX_PERSISTED_AVAILABILITY_OUTCOMES = 8;

interface AvailabilityRow {
  teammate_id: string;
  runtime_profile_id: string;
  status: ModelAvailabilityStatus;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  recent_outcomes_json: string;
  policy_version: string;
}

/** Current bounded availability projection for sealed MODEL_RUNTIME identities. */
export class R32AvailabilityRepository {
  constructor(private readonly db: Database.Database) {}

  getAvailability(teammateId: string): ModelAvailabilityProjection | null {
    const row = this.db
      .prepare('SELECT * FROM teammate_model_availability WHERE teammate_id = ?')
      .get(teammateId) as AvailabilityRow | undefined;
    return row ? mapAvailability(row) : null;
  }

  listAvailability(): ModelAvailabilityProjection[] {
    return (
      this.db
        .prepare('SELECT * FROM teammate_model_availability ORDER BY teammate_id')
        .all() as AvailabilityRow[]
    ).map(mapAvailability);
  }

  saveAvailability(projection: ModelAvailabilityProjection): void {
    validateProjection(projection);
    const binding = this.db
      .prepare(
        `SELECT b.runtime_profile_id, b.sealed_at, t.executor_kind, t.system_kind,
                t.current_runtime_profile_id
         FROM teammate_model_bindings AS b
         JOIN teammates AS t ON t.id = b.teammate_id
         WHERE b.teammate_id = ?`,
      )
      .get(projection.teammateId) as
      | {
          runtime_profile_id: string;
          sealed_at: string;
          executor_kind: string;
          system_kind: string | null;
          current_runtime_profile_id: string | null;
        }
      | undefined;
    if (
      !binding ||
      binding.executor_kind !== 'MODEL_RUNTIME' ||
      binding.system_kind !== null ||
      binding.current_runtime_profile_id !== binding.runtime_profile_id
    ) {
      throw new Error('Availability can only be saved for a sealed MODEL_RUNTIME teammate');
    }
    if (projection.runtimeProfileId !== binding.runtime_profile_id) {
      throw new Error('Availability runtime must match the teammate sealed ModelBinding');
    }

    const existing = this.db
      .prepare('SELECT updated_at FROM teammate_model_availability WHERE teammate_id = ?')
      .get(projection.teammateId) as { updated_at: string } | undefined;
    const updatedAt =
      projection.lastCheckedAt ??
      projection.lastSuccessAt ??
      projection.lastFailureAt ??
      existing?.updated_at ??
      binding.sealed_at;

    this.db
      .prepare(
        `INSERT INTO teammate_model_availability
          (teammate_id, runtime_profile_id, status, last_checked_at, last_success_at,
           last_failure_at, recent_outcomes_json, policy_version, updated_at)
         VALUES (@teammateId, @runtimeProfileId, @status, @lastCheckedAt, @lastSuccessAt,
           @lastFailureAt, @recentOutcomes, @policyVersion, @updatedAt)
         ON CONFLICT(teammate_id) DO UPDATE SET
           status=excluded.status, last_checked_at=excluded.last_checked_at,
           last_success_at=excluded.last_success_at, last_failure_at=excluded.last_failure_at,
           recent_outcomes_json=excluded.recent_outcomes_json,
           policy_version=excluded.policy_version, updated_at=excluded.updated_at`,
      )
      .run({
        ...projection,
        lastCheckedAt: projection.lastCheckedAt,
        lastSuccessAt: projection.lastSuccessAt,
        lastFailureAt: projection.lastFailureAt,
        recentOutcomes: JSON.stringify(projection.recentOutcomes),
        policyVersion: projection.policyVersion,
        updatedAt,
      });
  }
}

function mapAvailability(row: AvailabilityRow): ModelAvailabilityProjection {
  const recentOutcomes = JSON.parse(row.recent_outcomes_json) as AvailabilityOutcome[];
  if (
    !Array.isArray(recentOutcomes) ||
    recentOutcomes.length > MAX_PERSISTED_AVAILABILITY_OUTCOMES
  ) {
    throw new Error('Stored availability outcomes exceed the supported bound');
  }
  const projection: ModelAvailabilityProjection = {
    teammateId: row.teammate_id,
    runtimeProfileId: row.runtime_profile_id,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    recentOutcomes,
    policyVersion: row.policy_version,
  };
  validateProjection(projection);
  return projection;
}

function validateProjection(value: ModelAvailabilityProjection): void {
  if (!value.teammateId.trim() || !value.runtimeProfileId.trim()) {
    throw new Error('Availability projection requires a teammate and Runtime identity');
  }
  if (!isAvailabilityStatus(value.status)) {
    throw new Error('Availability status is invalid');
  }
  if (!value.policyVersion.trim() || value.policyVersion.length > 80) {
    throw new Error('Availability policy version must be bounded');
  }
  if (
    !Array.isArray(value.recentOutcomes) ||
    value.recentOutcomes.length > MAX_PERSISTED_AVAILABILITY_OUTCOMES
  ) {
    throw new Error(`Availability retains at most ${MAX_PERSISTED_AVAILABILITY_OUTCOMES} outcomes`);
  }
  for (const outcome of value.recentOutcomes) validateOutcome(outcome);
  for (const timestamp of [value.lastCheckedAt, value.lastSuccessAt, value.lastFailureAt]) {
    if (timestamp !== null && !isValidTimestamp(timestamp)) {
      throw new Error('Availability timestamps must be valid ISO timestamps');
    }
  }

  if (value.status === 'UNKNOWN') {
    if (
      value.lastCheckedAt !== null ||
      value.lastSuccessAt !== null ||
      value.lastFailureAt !== null ||
      value.recentOutcomes.length !== 0
    ) {
      throw new Error('UNKNOWN availability cannot claim a check outcome');
    }
    return;
  }

  if (value.lastCheckedAt === null || value.recentOutcomes.length === 0) {
    throw new Error('Checked availability requires a timestamp and a recent outcome');
  }
  if (value.status === 'AVAILABLE' && value.lastSuccessAt === null) {
    throw new Error('AVAILABLE requires a successful model request');
  }
  if (value.status === 'UNAVAILABLE' && value.lastFailureAt === null) {
    throw new Error('UNAVAILABLE requires a failure timestamp');
  }
  const checkedAt = Date.parse(value.lastCheckedAt);
  for (const timestamp of [value.lastSuccessAt, value.lastFailureAt]) {
    if (timestamp !== null && Date.parse(timestamp) > checkedAt) {
      throw new Error('Availability outcome timestamps cannot be after the latest check');
    }
  }
  for (const outcome of value.recentOutcomes) {
    if (Date.parse(outcome.checkedAt) > checkedAt) {
      throw new Error('Recent availability outcomes cannot be after the latest check');
    }
  }
}

function validateOutcome(value: AvailabilityOutcome): void {
  const outcomeKeys = Object.keys(value);
  if (
    outcomeKeys.length !== 3 ||
    !['kind', 'code', 'checkedAt'].every((key) => outcomeKeys.includes(key))
  ) {
    throw new Error('Availability outcomes cannot contain unbounded extra fields');
  }
  if (!['SUCCESS', 'HARD_FAILURE', 'TRANSIENT_FAILURE'].includes(value.kind)) {
    throw new Error('Availability outcome kind is invalid');
  }
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(value.code)) {
    throw new Error('Availability outcome code must be a bounded safe code');
  }
  if (!isValidTimestamp(value.checkedAt)) {
    throw new Error('Availability outcome timestamp must be a valid ISO timestamp');
  }
}

function isAvailabilityStatus(value: string): value is ModelAvailabilityStatus {
  return ['UNKNOWN', 'AVAILABLE', 'UNSTABLE', 'UNAVAILABLE'].includes(value);
}

function isValidTimestamp(value: string): boolean {
  if (value.length === 0 || value.length > 64 || value.trim() !== value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
