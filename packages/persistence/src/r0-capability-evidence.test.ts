import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations, R0SqliteRepository, runMigrations } from './index.js';
import type { CapabilityEvidenceRecord, ExternalWorkRequestRecord } from './r0.js';

let db: Database.Database;
let repository: R0SqliteRepository;

function fixture(steps = migrations): void {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, steps);
  repository = new R0SqliteRepository(db);
  db.exec(`
    INSERT INTO providers (id, name, kind, created_at, updated_at)
      VALUES ('provider', 'Provider', 'OPENAI', 'created', 'updated');
    INSERT INTO runtime_profiles (id, name, provider_id, model_id, created_at, updated_at)
      VALUES ('runtime-old', 'Old', 'provider', 'model-old', 'created', 'updated'),
             ('runtime-new', 'New', 'provider', 'model-new', 'created', 'updated');
    INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
      VALUES ('coordinator', 'Coordinator', 'runtime-old', 'created', 'updated'),
             ('member', 'Member', 'runtime-old', 'created', 'updated'),
             ('outsider', 'Outsider', 'runtime-old', 'created', 'updated');
    INSERT INTO parties (id, name, coordinator_teammate_id, type, created_at)
      VALUES ('party', 'Party', 'coordinator', 'FIXED', 'created');
    INSERT INTO party_members (party_id, teammate_id, role, sort_order)
      VALUES ('party', 'coordinator', 'COORDINATOR', 0),
             ('party', 'member', 'MEMBER', 1);
    INSERT INTO missions
      (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
       party_id, mode, state, created_at, updated_at)
      VALUES ('mission', 'Mission', 'Objective', 'USER', 'user', 'coordinator',
              'party', 'CONSULTATION', 'RUNNING', 'created', 'updated');
    INSERT INTO mission_participants (mission_id, teammate_id, role, sort_order)
      VALUES ('mission', 'coordinator', 'COORDINATOR', 0),
             ('mission', 'member', 'MEMBER', 1);
    INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
      VALUES ('run-1', 'mission', 1, 'RUNNING', 'started');
  `);
  repository.ensureHumanBridgeTeammate({
    id: 'bridge',
    createdAt: 'created',
    updatedAt: 'updated',
  });
}

function enableBridgeRequestCapability(): void {
  db.prepare(
    `INSERT OR IGNORE INTO party_members (party_id, teammate_id, role, sort_order)
     VALUES ('party', 'bridge', 'MEMBER', 2)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO mission_participants (mission_id, teammate_id, role, sort_order)
     VALUES ('mission', 'bridge', 'MEMBER', 2)`,
  ).run();
  repository.saveHumanBridgeCapability({
    teammateId: 'bridge',
    dimension: 'IMAGE_GENERATION',
    enabled: true,
    updatedAt: 'configured',
  });
}

function terminal(runId = 'run-1', status: 'COMPLETED' | 'FAILED' = 'COMPLETED'): void {
  db.prepare('UPDATE mission_runs SET status = ?, ended_at = ? WHERE id = ?').run(
    status,
    'ended',
    runId,
  );
}

function modelCall(teammateId = 'member', runtimeProfileId = 'runtime-old', runId = 'run-1'): void {
  db.prepare(
    `INSERT INTO mission_events
      (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
     VALUES (?, 'mission', ?, 'model.call_started', 'TEAMMATE', ?, ?, 'call-time')`,
  ).run(`call-${teammateId}-${runId}`, runId, teammateId, JSON.stringify({ runtimeProfileId }));
}

function evidence(overrides: Partial<CapabilityEvidenceRecord> = {}): CapabilityEvidenceRecord {
  return {
    id: 'evidence-1',
    teammateId: 'member',
    runtimeProfileId: 'runtime-old',
    missionId: 'mission',
    runId: 'run-1',
    dimension: 'CODING',
    sourceType: 'USER_DIMENSION_RATING',
    ratingValue: 80,
    demandWeight: 1,
    evidenceWeight: 1,
    createdAt: 'rating-time',
    ...overrides,
  };
}

function externalRequest(): ExternalWorkRequestRecord {
  return {
    id: 'external-work',
    missionId: 'mission',
    runId: 'run-1',
    requesterTeammateId: 'coordinator',
    assigneeTeammateId: 'bridge',
    capability: 'IMAGE_GENERATION',
    title: 'Create image',
    prompt: 'Create a requested image',
    requirementsJson: { items: [] },
    targetArtifactsJson: {
      items: [
        {
          id: 'primary-image',
          name: 'Primary image',
          required: true,
          allowedExtensions: ['png'],
          maxSizeBytes: 1_000_000,
        },
      ],
    },
    targetWorkspacePathsJson: { items: ['workspace/output'] },
    acceptanceCriteriaJson: { items: [] },
    externalAppProfileId: null,
    publicResult: null,
    state: 'PENDING',
    createdAt: 'created',
    submittedAt: null,
    resolvedAt: null,
  };
}

function appendExternalWorkArtifact(requestId: string, submittedAt: string): void {
  repository.appendExternalWorkArtifact({
    id: `artifact-${submittedAt}`,
    externalWorkRequestId: requestId,
    path: 'workspace/output/result.png',
    fileName: 'result.png',
    extension: 'png',
    sizeBytes: 100,
    mimeType: 'image/png',
    metadataJson: {},
    submittedAt,
  });
}

describe('R0 CapabilityEvidence execution provenance', () => {
  beforeEach(() => fixture());
  afterEach(() => db.close());

  it('rejects MODEL_RUNTIME evidence without a runtime even after a model call', () => {
    modelCall();
    terminal();
    expect(() =>
      repository.appendCapabilityEvidence(evidence({ runtimeProfileId: null })),
    ).toThrow();
  });

  it('rejects a runtime different from the actual model call', () => {
    modelCall();
    terminal();
    expect(() =>
      repository.appendCapabilityEvidence(evidence({ runtimeProfileId: 'runtime-new' })),
    ).toThrow();
  });

  it('rejects a participant with no execution and a denied collaboration target', () => {
    db.prepare(
      `INSERT INTO collaboration_requests
        (id, mission_id, run_id, requester_teammate_id, target_teammate_id,
         reason, proposed_task, state, created_at)
       VALUES ('denied', 'mission', 'run-1', 'coordinator', 'member',
         'Need review', 'Review draft', 'PENDING', 'proposed')`,
    ).run();
    db.prepare(
      "UPDATE collaboration_requests SET state = 'DENIED', resolved_at = 'denied' WHERE id = 'denied'",
    ).run();
    terminal();
    expect(() => repository.appendCapabilityEvidence(evidence())).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM capability_evidence').get()).toEqual({
      count: 0,
    });
  });

  it('accepts the actual historical runtime even after Runtime migration', () => {
    modelCall();
    db.prepare(
      "UPDATE teammates SET current_runtime_profile_id = 'runtime-new' WHERE id = 'member'",
    ).run();
    terminal();
    repository.appendCapabilityEvidence(evidence());
    expect(repository.listCapabilityEvidence('member')).toEqual([evidence()]);
    expect(() =>
      repository.appendCapabilityEvidence(
        evidence({ id: 'wrong', runtimeProfileId: 'runtime-new' }),
      ),
    ).toThrow();
    expect(() => db.prepare('UPDATE capability_evidence SET rating_value = 0').run()).toThrow();
    expect(() => db.prepare('DELETE FROM capability_evidence').run()).toThrow();
  });

  it('accepts matching durable Usage when a started event is unavailable', () => {
    db.prepare(
      `INSERT INTO usage_records
        (id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
         input_tokens, output_tokens, created_at)
       VALUES ('usage', 'mission', 'run-1', 'member', 'runtime-old', 'OPENAI',
         'model-old', 3, 2, 'usage-time')`,
    ).run();
    terminal();
    repository.appendCapabilityEvidence(evidence());
    expect(repository.listCapabilityEvidence('member')).toEqual([evidence()]);
  });

  it('does not let an outsider borrow another participant model call', () => {
    modelCall('outsider');
    terminal();
    expect(() =>
      repository.appendCapabilityEvidence(evidence({ teammateId: 'outsider' })),
    ).toThrow();
  });

  it('rejects USER_BRIDGE evidence with a runtime even after accepted external work', () => {
    enableBridgeRequestCapability();
    repository.createExternalWorkRequest(externalRequest());
    repository.transitionExternalWorkRequest('external-work', 'IN_PROGRESS', 'started');
    repository.transitionExternalWorkRequest('external-work', 'SUBMITTED', 'submitted');
    appendExternalWorkArtifact('external-work', 'submitted');
    repository.transitionExternalWorkRequest('external-work', 'ACCEPTED', 'accepted');
    terminal();
    expect(() =>
      repository.appendCapabilityEvidence(
        evidence({ teammateId: 'bridge', runtimeProfileId: 'runtime-old' }),
      ),
    ).toThrow();
  });

  it('rejects USER_BRIDGE membership or an unaccepted external request', () => {
    // Membership can change after an attempt starts; it is never execution proof.
    enableBridgeRequestCapability();
    repository.createExternalWorkRequest(externalRequest());
    repository.transitionExternalWorkRequest('external-work', 'IN_PROGRESS', 'started');
    repository.transitionExternalWorkRequest('external-work', 'SUBMITTED', 'submitted');
    terminal();
    expect(() =>
      repository.appendCapabilityEvidence(
        evidence({ teammateId: 'bridge', runtimeProfileId: null }),
      ),
    ).toThrow();
  });

  it('accepts USER_BRIDGE only after its own external work is accepted', () => {
    enableBridgeRequestCapability();
    repository.createExternalWorkRequest(externalRequest());
    repository.transitionExternalWorkRequest('external-work', 'IN_PROGRESS', 'started');
    repository.transitionExternalWorkRequest('external-work', 'SUBMITTED', 'submitted');
    appendExternalWorkArtifact('external-work', 'submitted');
    repository.transitionExternalWorkRequest('external-work', 'ACCEPTED', 'accepted');
    terminal();
    const rating = evidence({
      teammateId: 'bridge',
      runtimeProfileId: null,
      dimension: 'IMAGE_GENERATION',
    });
    repository.appendCapabilityEvidence(rating);
    expect(repository.listCapabilityEvidence('bridge')).toEqual([rating]);
  });

  it('rejects RUNNING Run evidence despite a matching model call', () => {
    modelCall();
    expect(() => repository.appendCapabilityEvidence(evidence())).toThrow();
  });

  it('keeps execution facts isolated across Retry attempts', () => {
    modelCall();
    terminal();
    db.prepare(
      `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
       VALUES ('run-2', 'mission', 2, 'RUNNING', 'retry-start')`,
    ).run();
    terminal('run-2', 'FAILED');
    expect(() => repository.appendCapabilityEvidence(evidence({ runId: 'run-2' }))).toThrow();
    repository.appendCapabilityEvidence(evidence());
    expect(repository.listCapabilityEvidence('member')).toEqual([evidence()]);
  });

  it('upgrades populated 0009 data to the latest schema without changing existing facts', () => {
    db.close();
    fixture(migrations.slice(0, 9));
    modelCall();
    terminal();
    repository.appendCapabilityEvidence(evidence());
    runMigrations(db, migrations);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 22,
    });
    expect(repository.listCapabilityEvidence('member')).toEqual([evidence()]);
    expect(() =>
      repository.appendCapabilityEvidence(evidence({ id: 'new-invalid', runtimeProfileId: null })),
    ).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
