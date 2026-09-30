import { describe, expect, it } from 'vitest';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import {
  AvailabilityService,
  AvailabilityAwareModelGateway,
  RoutingEligibilityService,
} from '@cultivation/application';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { Gate3MissionService } from '@cultivation/application/gate3-mission-service';
import { Gate5PartyService } from '@cultivation/application/gate5-party-service';
import { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import { Gate6ExperienceService } from '@cultivation/application/gate6-experience-service';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { ToolRegistry, ToolRuntime } from '@cultivation/application/tool-runtime';
import {
  openDatabase,
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
  Gate5SqliteRepository,
  R32AvailabilityRepository,
  Gate6SqliteRepository,
} from '@cultivation/persistence';

async function setup() {
  const db = openDatabase(':memory:');
  const store = new Gate1SqliteRepository(db);
  const missionStore = new Gate3SqliteRepository(db);
  const partyStore = new Gate5SqliteRepository(db);
  const projectionStore = new R32AvailabilityRepository(db);
  const probes: string[] = [];
  const availability = new AvailabilityService(projectionStore, store, {
    probe: async (id) => {
      probes.push(id);
      return { kind: 'SUCCESS', code: 'PROBE_SUCCEEDED' };
    },
  });
  const raw = new FakeModelGateway();
  const gateway = new AvailabilityAwareModelGateway(raw, availability);
  const service = new Gate1Service(
    store,
    {
      encrypt: async () => new Uint8Array([1]),
      decrypt: async () => 'test-only',
    },
    gateway,
  );
  const provider = service.createProvider({
    name: 'Fixture',
    kind: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://localhost:1234/v1',
  });
  const runtime = service.createRuntimeProfile({
    name: 'Fixture',
    providerId: provider.id,
    credentialId: null,
    modelId: 'fixture-model',
  });
  const teammateInput = {
    name: 'A',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  };
  const a = await service.createTeammate(teammateInput);
  const b = await service.createTeammate({ ...teammateInput, name: 'B' });
  const permissions = new PermissionEngine(missionStore);
  const tools = new ToolRuntime(new ToolRegistry(), permissions);
  const missions = new Gate3MissionService(missionStore, store, permissions, gateway);
  missions.attachTools(tools, new Gate4SqliteRepository(db));
  const parties = new Gate5PartyService(partyStore, store);
  const partyMissions = new Gate5CollaborationService(
    missionStore,
    partyStore,
    parties,
    store,
    permissions,
    gateway,
    undefined,
    tools,
  );
  return {
    db,
    store,
    projectionStore,
    availability,
    probes,
    service,
    a,
    b,
    provider,
    missions,
    parties,
    partyMissions,
    missionStore,
  };
}

describe('R3.2 existing execution paths', () => {
  it('Chat, SOLO tool loop, proposal, Participant and Synthesis update the actual fixed identities', async () => {
    const f = await setup();
    try {
      expect(f.availability.get(f.a.id)?.status).toBe('UNKNOWN');
      const conversation = f.service.createConversation(f.a.id);
      for await (const event of f.service.streamChat({
        teammateId: f.a.id,
        conversationId: conversation.id,
        text: 'PING',
      }))
        expect(event.type).toMatch(/delta|done/);
      expect(f.availability.get(f.a.id)?.status).toBe('AVAILABLE');
      expect(f.probes).toEqual([f.a.currentRuntimeProfileId]);
      const solo = f.missions.create({
        title: 'Solo',
        objective: 'Normal answer',
        coordinatorTeammateId: f.a.id,
      });
      f.missions.ready(solo.id);
      expect(
        (await f.missions.start({ missionId: solo.id, approvalFixture: false })).mission.state,
      ).toBe('COMPLETED');
      const party = f.parties.createParty({
        name: 'Pair',
        description: '',
        type: 'FIXED',
        coordinatorTeammateId: f.a.id,
        memberTeammateIds: [f.a.id, f.b.id],
      });
      for (const mode of ['CONSULTATION', 'REVIEW', 'DELEGATION'] as const) {
        const mission = f.partyMissions.create({
          title: mode,
          objective: 'Independent perspective',
          mode,
          partyId: party.id,
        });
        f.partyMissions.ready(mission.id);
        const pending = await f.partyMissions.start(mission.id);
        const request = pending.collaborations.find((r) => r.state === 'PENDING')!;
        const completed = await f.partyMissions.resolveCollaboration({
          requestId: request.id,
          decision: 'APPROVED',
        });
        expect(completed.mission.state).toBe('COMPLETED');
        const phases = completed.events
          .filter((e) => e.eventType === 'model.call_started')
          .map((e) => e.payloadJson.phase);
        expect(phases).toEqual(
          expect.arrayContaining(['COLLABORATION_PROPOSAL', 'PARTICIPANT', 'SYNTHESIS']),
        );
        expect(
          completed.usage.some(
            (u) => u.teammateId === f.b.id && u.runtimeProfileId === f.b.currentRuntimeProfileId,
          ),
        ).toBe(true);
      }
      expect(f.availability.get(f.b.id)?.status).toBe('AVAILABLE');
      expect(f.probes).toEqual([f.a.currentRuntimeProfileId, f.b.currentRuntimeProfileId]);
      expect(f.availability.get(f.a.id)?.recentOutcomes).toHaveLength(8);
      expect(f.db.prepare('SELECT count(*) AS n FROM capability_evidence').get()).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });

  it('explicit unavailable teammate is never reassigned and creates no model-call/usage facts', async () => {
    const f = await setup();
    try {
      await f.availability.recordOutcome({
        teammateId: f.a.id,
        runtimeProfileId: f.a.currentRuntimeProfileId!,
        kind: 'HARD_FAILURE',
        code: 'AUTH_FAILED',
      });
      const conversation = f.service.createConversation(f.a.id);
      const stream = async () => {
        for await (const item of f.service.streamChat({
          teammateId: f.a.id,
          conversationId: conversation.id,
          text: 'PING',
        }))
          void item;
      };
      await expect(stream()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
      const mission = f.missions.create({
        title: 'Explicit',
        objective: 'Answer',
        coordinatorTeammateId: f.a.id,
      });
      f.missions.ready(mission.id);
      const result = await f.missions.start({ missionId: mission.id, approvalFixture: false });
      expect(result.runs[0]?.errorCode).toBe('MODEL_UNAVAILABLE');
      expect(result.events.filter((e) => e.eventType === 'model.call_started')).toHaveLength(0);
      expect(result.usage).toHaveLength(0);
      expect(f.probes).toHaveLength(0);
      expect(f.availability.get(f.b.id)?.status).toBe('UNKNOWN');
    } finally {
      f.db.close();
    }
  });

  it('provider disabled is excluded without network probes or changing sealed identity', async () => {
    const f = await setup();
    try {
      const binding = f.store.getModelBinding(f.a.id);
      f.store.saveProvider({ ...f.provider, enabled: false });
      const eligibility = new RoutingEligibilityService(f.store, f.availability);
      expect(eligibility.evaluate(f.a.id).eligible).toBe(false);
      expect(
        (
          await f.availability.prepare({
            teammateId: f.a.id,
            runtimeProfileId: f.a.currentRuntimeProfileId!,
          })
        ).ok,
      ).toBe(false);
      expect(f.availability.get(f.a.id)?.status).toBe('UNAVAILABLE');
      expect(f.probes).toHaveLength(0);
      expect(f.store.getModelBinding(f.a.id)).toEqual(binding);
    } finally {
      f.db.close();
    }
  });

  it('a member becoming unavailable at the final pre-send guard has no execution provenance', async () => {
    const f = await setup();
    try {
      const party = f.parties.createParty({
        name: 'Pair',
        description: '',
        type: 'FIXED',
        coordinatorTeammateId: f.a.id,
        memberTeammateIds: [f.a.id, f.b.id],
      });
      const mission = f.partyMissions.create({
        title: 'Guard race',
        objective: 'Independent perspective',
        mode: 'CONSULTATION',
        partyId: party.id,
      });
      f.partyMissions.ready(mission.id);
      const pending = await f.partyMissions.start(mission.id);
      let prepares = 0;
      const prepare = f.availability.prepare.bind(f.availability);
      f.availability.prepare = async (input) => {
        if (input.teammateId === f.b.id && ++prepares === 3) {
          await f.availability.recordOutcome({
            ...input,
            kind: 'HARD_FAILURE',
            code: 'CONNECTION_REFUSED',
          });
        }
        return prepare(input);
      };
      const result = await f.partyMissions.resolveCollaboration({
        requestId: pending.collaborations[0]!.id,
        decision: 'APPROVED',
      });
      expect(result.mission.state).toBe('COMPLETED');
      expect(result.artifacts.filter((a) => a.teammateId === f.b.id)).toHaveLength(0);
      expect(result.usage.filter((u) => u.teammateId === f.b.id)).toHaveLength(0);
      expect(
        result.events.filter(
          (e) =>
            e.actorId === f.b.id &&
            [
              'model.call_started',
              'collaboration.started',
              'collaboration.failed',
              'collaboration.completed',
            ].includes(e.eventType),
        ),
      ).toHaveLength(0);
      expect(result.events.some((e) => e.eventType === 'collaboration.unavailable')).toBe(true);
      const experience = new Gate6ExperienceService(new Gate6SqliteRepository(f.db));
      experience.reconcileAll();
      expect(new Gate6SqliteRepository(f.db).listExperienceEvents(f.b.id)).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });
});
