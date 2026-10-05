import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  CollaborationArtifact,
  CollaborationRequest,
  MissionParticipant,
  PartyMember,
} from '@cultivation/domain';
import {
  Gate3SqliteRepository,
  Gate5SqliteRepository,
  migrations,
  runMigrations,
} from './index.js';

function fixture(withRun = true) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  db.prepare(
    `INSERT INTO providers (id,name,kind,created_at,updated_at) VALUES ('p','P','OPENAI','now','now')`,
  ).run();
  db.prepare(
    `INSERT INTO runtime_profiles (id,name,provider_id,model_id,created_at,updated_at)
     VALUES ('r','Runtime','p','model','now','now')`,
  ).run();
  const addTeammate = db.prepare(
    `INSERT INTO teammates (id,name,current_runtime_profile_id,created_at,updated_at)
     VALUES (?, ?, 'r', 'now', 'now')`,
  );
  for (const id of ['a', 'b', 'c', 'd', 'e']) addTeammate.run(id, id.toUpperCase());
  db.prepare(
    `INSERT INTO parties (id,name,coordinator_teammate_id,type,status,created_at)
     VALUES ('party','Party','a','FIXED','ACTIVE','now')`,
  ).run();
  db.prepare(
    `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,coordinator_teammate_id,
       party_id,mode,state,created_at,updated_at)
     VALUES ('mission','Mission','Objective','USER','user','a','party','CONSULTATION','READY','now','now')`,
  ).run();
  const repository = new Gate5SqliteRepository(db);
  const members: PartyMember[] = [
    { partyId: 'party', teammateId: 'a', role: 'COORDINATOR', order: 0 },
    { partyId: 'party', teammateId: 'b', role: 'MEMBER', order: 1 },
    { partyId: 'party', teammateId: 'c', role: 'MEMBER', order: 2 },
  ];
  repository.saveParty(
    {
      id: 'party',
      name: 'Party',
      description: '',
      coordinatorTeammateId: 'a',
      type: 'FIXED',
      status: 'ACTIVE',
      createdAt: 'now',
    },
    members,
  );
  const participants: MissionParticipant[] = [
    { missionId: 'mission', teammateId: 'a', role: 'COORDINATOR', sortOrder: 0 },
    { missionId: 'mission', teammateId: 'b', role: 'MEMBER', sortOrder: 1 },
    { missionId: 'mission', teammateId: 'c', role: 'MEMBER', sortOrder: 2 },
  ];
  repository.saveMissionParticipants('mission', participants);
  if (withRun) {
    db.prepare(
      `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
       VALUES ('run','mission',1,'RUNNING','now')`,
    ).run();
  }
  return { db, repository, members, participants };
}

function request(overrides: Partial<CollaborationRequest> = {}): CollaborationRequest {
  return {
    id: 'request',
    missionId: 'mission',
    runId: 'run',
    requesterTeammateId: 'a',
    targetTeammateId: 'b',
    reason: 'Need an independent review',
    proposedTask: 'Review the current draft',
    expectedBenefit: 'Find a missing case',
    depth: 0,
    state: 'PENDING',
    createdAt: 'now',
    resolvedAt: null,
    ...overrides,
  };
}

describe('Gate 5 SQLite persistence', () => {
  it('accepts usage for the actual Party participant while rejecting nonparticipants and preserving SOLO ownership', () => {
    const { db } = fixture();
    const usageRepository = new Gate3SqliteRepository(db);
    const usage = {
      id: 'member-usage',
      missionId: 'mission',
      runId: 'run',
      teammateId: 'b',
      runtimeProfileId: 'r',
      provider: 'OPENAI',
      model: 'model',
      inputTokens: 8,
      outputTokens: 3,
      cachedInputTokens: null,
      reasoningTokens: null,
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: 'now',
    };
    try {
      usageRepository.saveUsage(usage);
      expect(usageRepository.listMissionUsage('mission')).toMatchObject([
        { teammateId: 'b', runId: 'run', runtimeProfileId: 'r' },
      ]);
      expect(() =>
        usageRepository.saveUsage({ ...usage, id: 'outsider-usage', teammateId: 'd' }),
      ).toThrow(/ownership must match/);
      expect(() =>
        db.prepare("UPDATE usage_records SET teammate_id = 'd' WHERE id = 'member-usage'").run(),
      ).toThrow(/ownership must match/);
      db.prepare(
        `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,
          coordinator_teammate_id,mode,state,created_at,updated_at)
         VALUES ('solo','Solo','Objective','USER','user','a','SOLO','RUNNING','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
         VALUES ('solo-run','solo',1,'RUNNING','now')`,
      ).run();
      expect(() =>
        usageRepository.saveUsage({
          ...usage,
          id: 'solo-noncoordinator',
          missionId: 'solo',
          runId: 'solo-run',
        }),
      ).toThrow(/ownership must match/);
      usageRepository.saveUsage({
        ...usage,
        id: 'solo-coordinator',
        missionId: 'solo',
        runId: 'solo-run',
        teammateId: 'a',
      });
    } finally {
      db.close();
    }
  });

  it('enforces 2–4 unique Party members with one matching Coordinator and rolls back failed replacements', () => {
    const { db, repository, members } = fixture();
    try {
      expect(repository.listParties()).toMatchObject([{ id: 'party', type: 'FIXED' }]);
      expect(repository.getParty('party')?.coordinatorTeammateId).toBe('a');
      expect(repository.listPartyMembers('party')).toEqual(members);
      expect(() =>
        repository.saveParty(
          { ...repository.getParty('party')!, coordinatorTeammateId: 'b' },
          members,
        ),
      ).toThrow(/Coordinator/);
      expect(repository.listPartyMembers('party')).toEqual(members);
      expect(() =>
        repository.saveParty(repository.getParty('party')!, members.slice(0, 1)),
      ).toThrow(/between two and four/);
      expect(() =>
        repository.saveParty(repository.getParty('party')!, [
          ...members,
          { partyId: 'party', teammateId: 'd', role: 'MEMBER', order: 3 },
          { partyId: 'party', teammateId: 'e', role: 'MEMBER', order: 4 },
        ]),
      ).toThrow(/between two and four/);
      expect(repository.archiveParty('party')).toBe(true);
      expect(repository.getParty('party')?.status).toBe('ARCHIVED');
      expect(repository.archiveParty('party')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('locks Mission participants to their Party and prevents changes after a Run starts', () => {
    const { db, repository, participants } = fixture(false);
    try {
      expect(repository.listMissionParticipants('mission')).toEqual(participants);
      expect(() =>
        repository.saveMissionParticipants('mission', [
          ...participants.slice(0, 2),
          { missionId: 'mission', teammateId: 'd', role: 'MEMBER', sortOrder: 2 },
        ]),
      ).toThrow(/match the selected Party/);
      expect(() =>
        repository.saveMissionParticipants('mission', [
          ...participants,
          { missionId: 'mission', teammateId: 'd', role: 'MEMBER', sortOrder: 3 },
        ]),
      ).toThrow(/match the selected Party/);
      expect(() => repository.saveMissionParticipants('other', participants)).toThrow();
      expect(() =>
        repository.saveMissionParticipants('mission', [
          { missionId: 'mission', teammateId: 'b', role: 'COORDINATOR', sortOrder: 0 },
          { missionId: 'mission', teammateId: 'a', role: 'MEMBER', sortOrder: 1 },
          { missionId: 'mission', teammateId: 'c', role: 'MEMBER', sortOrder: 2 },
        ]),
      ).toThrow(/configured Coordinator/);
      expect(repository.listMissionParticipants('mission')).toEqual(participants);
      expect(() =>
        db
          .prepare(
            `INSERT INTO mission_participants (mission_id,teammate_id,role,sort_order)
             VALUES ('mission','d','OBSERVER',4)`,
          )
          .run(),
      ).toThrow(/invalid Mission participant role/);
      db.prepare(
        `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
         VALUES ('run','mission',1,'RUNNING','now')`,
      ).run();
      expect(() => repository.saveMissionParticipants('mission', participants)).toThrow(
        /immutable after a Run/,
      );
    } finally {
      db.close();
    }
  });

  it('creates Party Missions only with active members and available independent runtimes', () => {
    const { db, repository } = fixture();
    const mission = {
      id: 'party-mission',
      title: 'Consult',
      objective: 'Collect independent views',
      initiatorType: 'USER' as const,
      initiatorId: 'user',
      coordinatorTeammateId: 'a',
      partyId: 'party',
      mode: 'CONSULTATION' as const,
      state: 'DRAFT' as const,
      createdAt: 'now',
      updatedAt: 'now',
      completedAt: null,
    };
    try {
      repository.insertPartyMission(mission);
      expect(repository.listMissionParticipants('party-mission')).toMatchObject([
        { teammateId: 'a', role: 'COORDINATOR' },
        { teammateId: 'b', role: 'MEMBER' },
        { teammateId: 'c', role: 'MEMBER' },
      ]);
      expect(
        repository.updatePartyMissionDetails({
          ...mission,
          title: 'Consultation updated',
          updatedAt: 'later',
        }),
      ).toBe(true);
      expect(db.prepare("SELECT title FROM missions WHERE id = 'party-mission'").get()).toEqual({
        title: 'Consultation updated',
      });
      expect(() => repository.insertPartyMission(mission)).toThrow();
      db.prepare("UPDATE teammates SET status = 'ARCHIVED' WHERE id = 'b'").run();
      expect(() => repository.assertPartyMissionAvailable('party-mission')).toThrow(
        /Archived or unavailable/,
      );
      expect(() =>
        repository.insertPartyMission({ ...mission, id: 'unavailable-mission' }),
      ).toThrow(/Archived or unavailable/);
      expect(
        db.prepare("SELECT 1 FROM missions WHERE id = 'unavailable-mission'").get(),
      ).toBeUndefined();
      db.prepare("UPDATE teammates SET status = 'ACTIVE' WHERE id = 'b'").run();
      db.prepare("UPDATE parties SET status = 'ARCHIVED' WHERE id = 'party'").run();
      expect(() => repository.assertPartyMissionAvailable('party-mission')).toThrow(
        /Party is unavailable/,
      );
      db.prepare("UPDATE missions SET state = 'RUNNING' WHERE id = 'party-mission'").run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
             VALUES ('party-run','party-mission',1,'RUNNING','now')`,
          )
          .run(),
      ).toThrow(/Party Mission requires/);
      expect(() => repository.updatePartyMissionDetails({ ...mission, state: 'RUNNING' })).toThrow(
        /DRAFT or READY/,
      );
    } finally {
      db.close();
    }
  });

  it('links collaboration requests to the exact Mission Run and participant pair and resolves once', () => {
    const { db, repository } = fixture();
    try {
      repository.createCollaborationRequest(request());
      expect(repository.getCollaborationRequest('request')).toEqual(request());
      expect(repository.listCollaborationRequests('mission')).toEqual([request()]);
      expect(
        repository.resolveCollaborationRequest('request', 'APPROVED', 'resolved'),
      ).toMatchObject({ state: 'APPROVED', resolvedAt: 'resolved', runId: 'run' });
      expect(repository.resolveCollaborationRequest('request', 'DENIED', 'later')).toBeNull();
      repository.createCollaborationRequest(request({ id: 'permission-denied' }));
      expect(
        repository.resolveCollaborationRequest('permission-denied', 'DENIED', 'resolved'),
      ).toMatchObject({
        id: 'permission-denied',
        runId: 'run',
        targetTeammateId: 'b',
        state: 'DENIED',
      });
      expect(repository.listCollaborationArtifacts('mission', 'run')).toEqual([]);
      expect(() =>
        db
          .prepare(
            "UPDATE collaboration_requests SET proposed_task = 'mutated' WHERE id = 'request'",
          )
          .run(),
      ).toThrow(/resolved once/);
      expect(() =>
        repository.createCollaborationRequest(request({ id: 'bad-run', runId: 'missing' })),
      ).toThrow();
      expect(() =>
        repository.createCollaborationRequest(
          request({ id: 'bad-participant', targetTeammateId: 'd' }),
        ),
      ).toThrow();
      expect(() =>
        repository.createCollaborationRequest(request({ id: 'depth-2', depth: 2 as 0 | 1 })),
      ).toThrow(/depth is limited/);
      expect(() =>
        repository.createCollaborationRequest(request({ id: 'self', targetTeammateId: 'a' })),
      ).toThrow(/cannot invite itself/);
    } finally {
      db.close();
    }
  });

  it('stores bounded Draft/Review/Final artifacts as participant-owned append-only run history', () => {
    const { db, repository } = fixture();
    const artifact: CollaborationArtifact = {
      id: 'draft',
      missionId: 'mission',
      runId: 'run',
      teammateId: 'a',
      kind: 'DRAFT',
      content: 'Bounded mission draft',
      createdAt: 'now',
    };
    try {
      repository.appendCollaborationArtifact(artifact);
      repository.appendCollaborationArtifact({
        ...artifact,
        id: 'review',
        teammateId: 'b',
        kind: 'REVIEW',
      });
      repository.appendCollaborationArtifact({ ...artifact, id: 'final', kind: 'FINAL' });
      expect(repository.listCollaborationArtifacts('mission')).toHaveLength(3);
      expect(repository.listCollaborationArtifacts('mission', 'run')).toMatchObject([
        { id: 'draft', kind: 'DRAFT', teammateId: 'a' },
        { id: 'review', kind: 'REVIEW', teammateId: 'b' },
        { id: 'final', kind: 'FINAL', teammateId: 'a' },
      ]);
      expect(() =>
        repository.appendCollaborationArtifact({ ...artifact, id: 'wrong-run', runId: 'missing' }),
      ).toThrow();
      expect(() =>
        repository.appendCollaborationArtifact({ ...artifact, id: 'non-member', teammateId: 'd' }),
      ).toThrow();
      expect(() =>
        db
          .prepare("UPDATE collaboration_artifacts SET content = 'changed' WHERE id = 'draft'")
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        db.prepare("DELETE FROM collaboration_artifacts WHERE id = 'draft'").run(),
      ).toThrow(/append-only/);
      expect(() =>
        repository.appendCollaborationArtifact({
          ...artifact,
          id: 'oversize',
          content: 'x'.repeat(65_537),
        }),
      ).toThrow(/size limit/);
    } finally {
      db.close();
    }
  });

  it('persists and resolves Gate 5 participant tool continuations once for the matching pending approval', () => {
    const { db, repository } = fixture();
    try {
      db.prepare(
        `INSERT INTO approval_requests
          (id,mission_id,run_id,requester_teammate_id,capability,action_type,
           action_payload_json,risk_level,state,created_at)
         VALUES ('approval','mission','run','b','FILE_READ','tool.file.readText','{}','READ_ONLY','PENDING','now')`,
      ).run();
      const pending = {
        approvalId: 'approval',
        missionId: 'mission',
        runId: 'run',
        teammateId: 'b',
        contextJson: JSON.stringify({ phase: 'PARTICIPANT', task: 'review draft', transcript: [] }),
        stepCount: 2,
        toolCallCount: 1,
        state: 'PENDING' as const,
        createdAt: 'now',
        resolvedAt: null,
      };
      repository.saveGate5PendingToolCall(pending);
      expect(repository.getGate5PendingToolCall('approval')).toEqual(pending);
      expect(repository.resolveGate5PendingToolCall('approval', 'resolved')).toMatchObject({
        state: 'RESOLVED',
        resolvedAt: 'resolved',
        teammateId: 'b',
      });
      expect(repository.resolveGate5PendingToolCall('approval', 'again')).toBeNull();
      expect(() =>
        db
          .prepare(
            "UPDATE gate5_pending_tool_calls SET context_json = '{}' WHERE approval_id = 'approval'",
          )
          .run(),
      ).toThrow(/resolved once/);
      expect(() =>
        repository.saveGate5PendingToolCall({ ...pending, approvalId: 'missing-approval' }),
      ).toThrow();
      expect(() =>
        repository.saveGate5PendingToolCall({
          ...pending,
          approvalId: 'other-participant',
          teammateId: 'c',
        }),
      ).toThrow();
      expect(() =>
        repository.saveGate5PendingToolCall({
          ...pending,
          approvalId: 'large',
          contextJson: `{"x":"${'x'.repeat(3 * 1024 * 1024)}"}`,
        }),
      ).toThrow(/too large/);
    } finally {
      db.close();
    }
  });

  it('preserves pre-Gate-5 collaboration rows when migration adds run-scoped fields', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      runMigrations(db, migrations.slice(0, 5));
      db.prepare(
        `INSERT INTO providers (id,name,kind,created_at,updated_at) VALUES ('p','P','OPENAI','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO runtime_profiles (id,name,provider_id,model_id,created_at,updated_at)
         VALUES ('r','R','p','m','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO teammates (id,name,current_runtime_profile_id,created_at,updated_at)
         VALUES ('a','A','r','now','now'),('b','B','r','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,coordinator_teammate_id,
          mode,created_at,updated_at) VALUES ('m','M','O','USER','user','a','SOLO','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO collaboration_requests
          (id,mission_id,requester_teammate_id,target_teammate_id,reason,proposed_task,state)
         VALUES ('legacy','m','a','b','old reason','old task','PENDING')`,
      ).run();
      runMigrations(db, migrations);
      const legacy = db
        .prepare('SELECT * FROM collaboration_requests WHERE id = ?')
        .get('legacy') as {
        mission_id: string;
        run_id: string | null;
        expected_benefit: string;
        depth: number;
        created_at: string;
        state: string;
      };
      expect(legacy).toMatchObject({
        mission_id: 'm',
        run_id: null,
        expected_benefit: '',
        depth: 0,
        state: 'PENDING',
      });
      expect(legacy.created_at).not.toBe('');
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 26,
      });
    } finally {
      db.close();
    }
  });
});
