import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RoutingDecisionReceipt } from '@cultivation/domain';
import { migrations, runMigrations, R4RoutingRepository, R0SqliteRepository } from './index.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations.slice(0, 15));
  const before = db.prepare('SELECT count(*) AS count FROM schema_migrations').get();
  runMigrations(db, migrations);
  return { db, repository: new R4RoutingRepository(db), before };
}
function receipt(id = 'routing-1'): RoutingDecisionReceipt {
  return {
    id,
    assignment: null,
    taskSummary: 'Bounded public task',
    contextHash: 'a'.repeat(64),
    demand: [],
    candidates: [],
    decisionSignals: [],
    outcome: 'USER_ACTION_REQUIRED',
    reason: 'TASK_CAPABILITY_UNAVAILABLE',
    policyVersion: 'r4-controlled-routing-v1',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}
describe('R4 routing durable foundation', () => {
  it('permits Human Bridge self-request only for a routed SOLO and retains R2 validation', () => {
    const { db, repository } = setup();
    try {
      db.prepare(
        "INSERT INTO teammates(id,name,executor_kind,routing_policy,system_kind,created_at,updated_at) VALUES ('bridge','本尊','USER_BRIDGE','FALLBACK_ONLY','HUMAN_BRIDGE','now','now')",
      ).run();
      db.prepare(
        "INSERT INTO human_bridge_capabilities VALUES ('bridge','VIDEO_GENERATION',1,'now')",
      ).run();
      for (const id of ['routed', 'unrouted']) {
        db.prepare(
          "INSERT INTO missions(id,title,objective,initiator_type,initiator_id,coordinator_teammate_id,mode,state,created_at,updated_at) VALUES (?,?,?,'USER','user','bridge','SOLO','RUNNING','now','now')",
        ).run(id, 'Task', 'Objective');
        db.prepare(
          "INSERT INTO mission_runs(id,mission_id,attempt,status,started_at) VALUES (?,?,1,'RUNNING','now')",
        ).run(`${id}-run`, id);
      }
      const draft = {
        capability: 'VIDEO_GENERATION' as const,
        title: 'Task',
        prompt: 'User produces a bounded deliverable.',
        requirements: ['VIDEO_GENERATION'],
        targetArtifacts: [
          {
            id: 'result',
            name: 'result.txt',
            required: true,
            allowedExtensions: ['.txt'],
            maxSizeBytes: 1024,
          },
        ],
        targetWorkspacePaths: ['deliverables'],
        acceptanceCriteria: ['User accepts the result.'],
        externalAppProfileId: null,
      };
      const assignment = {
        id: 'routing-1',
        kind: 'HUMAN_BRIDGE' as const,
        coordinatorTeammateId: 'bridge',
        memberTeammateIds: [],
        partyId: null,
        mode: 'SOLO' as const,
        demand: [],
        policyVersion: 'r4-controlled-routing-v1',
      };
      repository.appendRoutingReceipt({ ...receipt(), outcome: 'ASSIGNED', assignment });
      repository.saveAssignment({
        missionId: 'routed',
        receiptId: assignment.id,
        assignment,
        context: { objective: 'Objective' },
        externalWorkDraft: draft,
        createdAt: 'now',
      });
      const external = new R0SqliteRepository(db);
      const request = (missionId: string) => ({
        id: `${missionId}-work`,
        missionId,
        runId: `${missionId}-run`,
        requesterTeammateId: 'bridge',
        assigneeTeammateId: 'bridge',
        capability: draft.capability,
        title: draft.title,
        prompt: draft.prompt,
        requirementsJson: { items: draft.requirements },
        targetArtifactsJson: { items: draft.targetArtifacts },
        targetWorkspacePathsJson: { items: draft.targetWorkspacePaths },
        acceptanceCriteriaJson: { items: draft.acceptanceCriteria },
        externalAppProfileId: null,
        publicResult: null,
        state: 'PENDING' as const,
        createdAt: 'now',
        submittedAt: null,
        resolvedAt: null,
      });
      expect(() => external.createExternalWorkRequest(request('unrouted'))).toThrow(
        /ExternalWorkRequest/,
      );
      expect(() =>
        external.createExternalWorkRequest({
          ...request('routed'),
          targetWorkspacePathsJson: { items: ['../outside'] },
        }),
      ).toThrow(/ExternalWorkRequest/);
      expect(() =>
        external.createExternalWorkRequest({
          ...request('routed'),
          capability: 'MUSIC_GENERATION',
        }),
      ).toThrow(/ExternalWorkRequest/);
      expect(external.createExternalWorkRequest(request('routed')).state).toBe('PENDING');
      expect(() =>
        external.transitionExternalWorkRequest('routed-work', 'ACCEPTED', 'later'),
      ).toThrow();
    } finally {
      db.close();
    }
  });
  it('upgrades 1–15 to 16 once with independent cloud consent off and SHADOW unchanged', () => {
    const { db, repository, before } = setup();
    try {
      expect(before).toEqual({ count: 15 });
      expect(repository.config()).toEqual({
        cloudEnabled: false,
        policyVersion: 'r4-controlled-routing-v1',
      });
      repository.setCloudEnabled(true);
      expect(repository.config().cloudEnabled).toBe(true);
      expect(db.prepare('SELECT mode, enabled FROM decision_provider_configs').get()).toEqual({
        mode: 'SHADOW',
        enabled: 0,
      });
      runMigrations(db, migrations);
      expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({
        count: 19,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('retains bounded append-only ACTIVE receipts without private facts and rejects duplicates', () => {
    const { db, repository } = setup();
    try {
      const value = receipt();
      repository.appendRoutingReceipt(value);
      expect(repository.listReceipts()).toEqual([value]);
      expect(() => repository.appendRoutingReceipt(value)).toThrow();
      expect(() =>
        db.prepare('UPDATE routing_decision_receipts SET created_at = ?').run('later'),
      ).toThrow(/append-only/);
      expect(() =>
        db.prepare('DELETE FROM routing_decision_receipts WHERE id = ?').run(value.id),
      ).toThrow(/append-only/);
      expect(db.prepare('SELECT mode FROM routing_decision_receipts').get()).toEqual({
        mode: 'ACTIVE',
      });
      expect(repository.listReceipts('not-a-mission')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('fails closed on missing receipt fields, invalid hash or excessive summaries', () => {
    const { db, repository } = setup();
    try {
      expect(() =>
        db
          .prepare(
            'INSERT INTO routing_decision_receipts(id,context_hash,receipt_json,created_at) VALUES (?,?,?,?)',
          )
          .run('missing', 'a'.repeat(64), '{}', 'now'),
      ).toThrow();
      expect(() => repository.appendRoutingReceipt({ ...receipt(), contextHash: 'bad' })).toThrow();
      expect(() =>
        repository.appendRoutingReceipt({ ...receipt(), taskSummary: 'x'.repeat(1201) }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
  it('requires an assignment to match the immutable receipt and Mission coordinator/mode', () => {
    const { db, repository } = setup();
    try {
      db.prepare(
        "INSERT INTO teammates(id,name,executor_kind,routing_policy,system_kind,created_at,updated_at) VALUES ('bridge','本尊','USER_BRIDGE','FALLBACK_ONLY','HUMAN_BRIDGE','now','now')",
      ).run();
      db.prepare(
        "INSERT INTO missions(id,title,objective,initiator_type,initiator_id,coordinator_teammate_id,mode,state,created_at,updated_at) VALUES ('mission','Task','Objective','USER','user','bridge','SOLO','DRAFT','now','now')",
      ).run();
      const assignment = {
        id: 'routing-1',
        kind: 'HUMAN_BRIDGE' as const,
        coordinatorTeammateId: 'bridge',
        memberTeammateIds: [],
        partyId: null,
        mode: 'SOLO' as const,
        demand: [],
        policyVersion: 'r4-controlled-routing-v1',
      };
      repository.appendRoutingReceipt({ ...receipt(), outcome: 'ASSIGNED', assignment });
      const record = {
        missionId: 'mission',
        receiptId: 'routing-1',
        assignment,
        context: { objective: 'Objective' },
        externalWorkDraft: null,
        createdAt: 'now',
      };
      expect(() =>
        repository.saveAssignment({
          ...record,
          assignment: { ...assignment, coordinatorTeammateId: 'someone-else' },
        }),
      ).toThrow(/match/);
      repository.saveAssignment(record);
      expect(repository.getByMissionId('mission')).toEqual(record);
      expect(repository.listReceipts('mission')).toHaveLength(1);
      expect(() =>
        db
          .prepare(
            "UPDATE routing_mission_assignments SET context_json = '{}' WHERE mission_id = 'mission'",
          )
          .run(),
      ).toThrow(/retained/);
      expect(() => repository.saveAssignment(record)).toThrow();
    } finally {
      db.close();
    }
  });
});
