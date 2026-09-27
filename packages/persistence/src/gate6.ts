import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ExperienceEvent, MissionMode, MissionRunStatus } from '@cultivation/domain';

interface RunSourceRow {
  id: string;
  mission_id: string;
  status: MissionRunStatus;
  ended_at: string | null;
  mode: MissionMode;
  coordinator_teammate_id: string;
}

interface MissionParticipantRow {
  mission_id: string;
  teammate_id: string;
  role: string;
}

interface ActorEvidenceRow {
  mission_id: string;
  run_id: string;
  teammate_id: string;
}

interface SourceEventRow {
  id: string;
  mission_id: string;
  run_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string;
  created_at: string;
  mode: MissionMode;
  run_status: MissionRunStatus;
}

interface ExperienceEventRow {
  id: string;
  teammate_id: string;
  mission_id: string;
  run_id: string;
  experience_type: ExperienceEvent['experienceType'];
  source: string;
  source_id: string;
  role: string;
  outcome: ExperienceEvent['outcome'];
  mode: MissionMode;
  created_at: string;
}

function terminalOutcome(status: MissionRunStatus): ExperienceEvent['outcome'] | null {
  return status === 'RUNNING' ? null : status;
}

/** SQLite ledger adapter. All source facts are read from immutable or terminal records. */
export class Gate6SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts any newly derivable facts; repeated calls are idempotent and return zero. */
  reconcileExperienceEvents(): number {
    return this.db.transaction(() => {
      const runs = this.db
        .prepare(
          `SELECT r.id, r.mission_id, r.status, r.ended_at, m.mode, m.coordinator_teammate_id
           FROM mission_runs AS r JOIN missions AS m ON m.id = r.mission_id
           WHERE r.status != 'RUNNING' ORDER BY r.started_at, r.id`,
        )
        .all() as RunSourceRow[];
      const participants = this.db
        .prepare('SELECT mission_id, teammate_id, role FROM mission_participants')
        .all() as MissionParticipantRow[];
      const rolesByMission = new Map<string, Map<string, string>>();
      for (const participant of participants) {
        let roles = rolesByMission.get(participant.mission_id);
        if (!roles) {
          roles = new Map();
          rolesByMission.set(participant.mission_id, roles);
        }
        roles.set(participant.teammate_id, participant.role);
      }

      const evidenceRows = this.db
        .prepare(
          `SELECT mission_id, run_id, teammate_id FROM usage_records
           WHERE mission_id IS NOT NULL AND run_id IS NOT NULL
           UNION
           SELECT mission_id, run_id, actor_id AS teammate_id FROM mission_events
           WHERE run_id IS NOT NULL AND actor_type = 'TEAMMATE' AND actor_id IS NOT NULL
             AND (event_type = 'model.call_started'
               OR (event_type = 'tool.result'
                 AND json_extract(payload_json, '$.success') = 1))
           UNION
           SELECT a.mission_id, a.run_id, a.teammate_id FROM collaboration_artifacts AS a
           WHERE NOT EXISTS (
             SELECT 1 FROM collaboration_requests AS c
             WHERE c.mission_id = a.mission_id AND c.run_id = a.run_id
               AND c.target_teammate_id = a.teammate_id AND c.state = 'DENIED'
           )`,
        )
        .all() as ActorEvidenceRow[];
      const actorsByRun = new Map<string, Set<string>>();
      for (const evidence of evidenceRows) {
        let actors = actorsByRun.get(evidence.run_id);
        if (!actors) {
          actors = new Set();
          actorsByRun.set(evidence.run_id, actors);
        }
        actors.add(evidence.teammate_id);
      }

      const sourceEvents = this.db
        .prepare(
          `SELECT e.id, e.mission_id, e.run_id, e.event_type, e.actor_type, e.actor_id,
                  e.payload_json, e.created_at, m.mode, r.status AS run_status
           FROM mission_events AS e
           JOIN mission_runs AS r ON r.id = e.run_id AND r.mission_id = e.mission_id
           JOIN missions AS m ON m.id = e.mission_id
           WHERE r.status != 'RUNNING'
             AND e.event_type IN ('collaboration.started', 'tool.result', 'skill.used')
           ORDER BY e.created_at, e.id`,
        )
        .all() as SourceEventRow[];
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO experience_events
          (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
           role, outcome, mode, created_at)
         VALUES (@id, @teammateId, @missionId, @runId, @experienceType, @source, @sourceId,
           @role, @outcome, @mode, @createdAt)`,
      );
      let inserted = 0;
      const add = (value: Omit<ExperienceEvent, 'id'>): void => {
        const result = insert.run({ id: randomUUID(), ...value });
        inserted += result.changes;
      };

      for (const run of runs) {
        if (!run.ended_at) continue;
        const outcome = terminalOutcome(run.status);
        if (!outcome) continue;
        const roles = rolesByMission.get(run.mission_id);
        const actors = actorsByRun.get(run.id) ?? new Set<string>();
        const eligible = new Map<string, string>();
        if (run.mode === 'SOLO') {
          if (actors.has(run.coordinator_teammate_id)) {
            eligible.set(run.coordinator_teammate_id, 'COORDINATOR');
          }
        } else {
          for (const teammateId of actors) {
            const role = roles?.get(teammateId);
            if (role) eligible.set(teammateId, role);
          }
        }
        for (const [teammateId, role] of eligible) {
          add({
            teammateId,
            missionId: run.mission_id,
            runId: run.id,
            experienceType: 'MISSION_RESULT',
            source: 'MISSION_RUN',
            sourceId: run.id,
            role,
            outcome,
            mode: run.mode,
            createdAt: run.ended_at,
          });
        }
      }

      for (const event of sourceEvents) {
        if (!event.actor_id || event.actor_type !== 'TEAMMATE') continue;
        const outcome = terminalOutcome(event.run_status);
        if (!outcome) continue;
        const role =
          event.mode === 'SOLO'
            ? event.actor_id ===
              runs.find((run) => run.id === event.run_id)?.coordinator_teammate_id
              ? 'COORDINATOR'
              : null
            : (rolesByMission.get(event.mission_id)?.get(event.actor_id) ?? null);
        if (!role) continue;
        const payload = parsePayload(event.payload_json);
        const sourceBase = {
          teammateId: event.actor_id,
          missionId: event.mission_id,
          runId: event.run_id,
          role,
          outcome,
          mode: event.mode,
          createdAt: event.created_at,
        } as const;
        if (
          event.event_type === 'collaboration.started' &&
          event.mode !== 'SOLO' &&
          actorsByRun.get(event.run_id)?.has(event.actor_id)
        ) {
          add({
            ...sourceBase,
            experienceType: 'COLLABORATION',
            source: 'COLLABORATION_EVENT',
            sourceId: event.id,
          });
        } else if (event.event_type === 'tool.result' && payload.success === true) {
          add({
            ...sourceBase,
            experienceType: 'TOOL_USE',
            source: 'MISSION_EVENT',
            sourceId: event.id,
          });
        } else if (
          event.event_type === 'skill.used' &&
          typeof payload.skillId === 'string' &&
          payload.skillId.length > 0
        ) {
          add({
            ...sourceBase,
            experienceType: 'SKILL_USE',
            source: 'MISSION_EVENT',
            sourceId: event.id,
          });
        }
      }
      return inserted;
    })();
  }

  listExperienceEvents(teammateId: string): ExperienceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM experience_events WHERE teammate_id = ?
         ORDER BY created_at, id`,
      )
      .all(teammateId) as ExperienceEventRow[];
    return rows.map(mapExperienceEvent);
  }
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapExperienceEvent(row: ExperienceEventRow): ExperienceEvent {
  return {
    id: row.id,
    teammateId: row.teammate_id,
    missionId: row.mission_id,
    runId: row.run_id,
    experienceType: row.experience_type,
    source: row.source,
    sourceId: row.source_id,
    role: row.role,
    outcome: row.outcome,
    mode: row.mode,
    createdAt: row.created_at,
  };
}
