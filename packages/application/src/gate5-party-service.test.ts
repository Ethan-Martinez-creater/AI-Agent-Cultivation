import { describe, expect, it } from 'vitest';
import type { Party, PartyMember, RuntimeProfile, Teammate } from '@cultivation/domain';
import {
  Gate5PartyService,
  type Gate5PartyStore,
  type Gate5PartyTeammateStore,
} from './gate5-party-service.js';

function setup() {
  const runtime: RuntimeProfile = {
    id: 'runtime-a',
    name: 'Runtime A',
    providerId: 'provider-a',
    credentialId: null,
    modelId: 'model-a',
    parameters: {},
    capabilityOverrides: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const teammates = new Map<string, Teammate>(
    ['a', 'b', 'c', 'd', 'e'].map((teammateId) => [
      teammateId,
      {
        id: teammateId,
        name: `Teammate ${teammateId}`,
        avatar: null,
        title: null,
        description: '',
        identityPrompt: '',
        behaviorPrompt: '',
        status: 'ACTIVE',
        realm: 'QI_REFINING',
        executorKind: 'MODEL_RUNTIME',
        routingPolicy: 'NORMAL',
        systemKind: null,
        currentRuntimeProfileId: runtime.id,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  );
  const runtimes = new Map([[runtime.id, runtime]]);
  const parties = new Map<string, Party>();
  const memberships = new Map<string, PartyMember[]>();
  const partyStore: Gate5PartyStore = {
    listParties: () => [...parties.values()],
    getParty: (partyId) => parties.get(partyId) ?? null,
    listPartyMembers: (partyId) => memberships.get(partyId) ?? [],
    saveParty: (party, members) => {
      parties.set(party.id, party);
      memberships.set(party.id, members);
    },
  };
  const teammateStore: Gate5PartyTeammateStore = {
    getTeammate: (teammateId) => teammates.get(teammateId) ?? null,
    getRuntimeProfile: (runtimeId) => runtimes.get(runtimeId) ?? null,
  };
  return {
    service: new Gate5PartyService(partyStore, teammateStore),
    teammates,
    parties,
    memberships,
    runtimes,
  };
}

function input(
  memberTeammateIds: string[],
  overrides: Partial<{
    name: string;
    description: string;
    type: 'FIXED' | 'AD_HOC';
    coordinatorTeammateId: string;
  }> = {},
) {
  return {
    name: overrides.name ?? 'Core Party',
    description: overrides.description ?? 'A persisted team',
    type: overrides.type ?? 'FIXED',
    coordinatorTeammateId: overrides.coordinatorTeammateId ?? memberTeammateIds[0] ?? 'a',
    memberTeammateIds,
  };
}

describe('Gate 5 Party application service', () => {
  it('creates persisted FIXED and AD_HOC parties with a real teammate Coordinator', () => {
    const { service, teammates, parties, memberships } = setup();
    const fixed = service.createParty(input(['a', 'b']));
    const adHoc = service.createParty(input(['c', 'd'], { type: 'AD_HOC', name: 'Temporary' }));

    expect([fixed.type, adHoc.type]).toEqual(['FIXED', 'AD_HOC']);
    expect(memberships.get(fixed.id)).toEqual([
      { partyId: fixed.id, teammateId: 'a', role: 'COORDINATOR', order: 0 },
      { partyId: fixed.id, teammateId: 'b', role: 'MEMBER', order: 1 },
    ]);
    expect(parties.size).toBe(2);
    expect(teammates.size).toBe(5);
    expect(teammates.has(fixed.coordinatorTeammateId)).toBe(true);
  });

  it('enforces 2–4 distinct members and requires the Coordinator in the roster', () => {
    const { service, parties } = setup();
    expect(() => service.createParty(input(['a']))).toThrow(/2 至 4/);
    expect(() => service.createParty(input(['a', 'b', 'c', 'd', 'e']))).toThrow(/2 至 4/);
    expect(() => service.createParty(input(['a', 'a']))).toThrow(/不可重复/);
    expect(() => service.createParty(input(['a', 'b'], { coordinatorTeammateId: 'c' }))).toThrow(
      /Coordinator 必须是 Party 成员/,
    );
    expect(parties.size).toBe(0);
  });

  it('rejects archived, missing, and runtime-unavailable members when saving or starting a Mission', () => {
    const { service, teammates, runtimes } = setup();
    teammates.set('b', { ...teammates.get('b')!, status: 'ARCHIVED' });
    expect(() => service.createParty(input(['a', 'b']))).toThrow(/不可用或已归档/);
    teammates.set('b', { ...teammates.get('b')!, status: 'ACTIVE' });
    teammates.set('c', { ...teammates.get('c')!, currentRuntimeProfileId: null });
    expect(() => service.createParty(input(['a', 'c']))).toThrow(/不可用或已归档/);
    teammates.set('c', { ...teammates.get('c')!, currentRuntimeProfileId: 'missing-runtime' });
    expect(() => service.createParty(input(['a', 'c']))).toThrow(/运行配置不可用/);
    teammates.set('c', { ...teammates.get('c')!, currentRuntimeProfileId: 'runtime-a' });
    const party = service.createParty(input(['a', 'b']));
    teammates.set('b', { ...teammates.get('b')!, status: 'ARCHIVED' });
    expect(() => service.validatePartyForMission(party.id)).toThrow(/不可用或已归档/);
    teammates.set('b', { ...teammates.get('b')!, status: 'ACTIVE' });
    runtimes.clear();
    expect(() => service.validatePartyForMission(party.id)).toThrow(/运行配置不可用/);
  });

  it('edits Party identity and membership without changing persisted Teammate identities', () => {
    const { service, teammates, memberships } = setup();
    const created = service.createParty(input(['a', 'b']));
    const edited = service.updateParty({
      id: created.id,
      ...input(['c', 'a'], {
        name: 'Updated party',
        description: 'New description',
        type: 'AD_HOC',
        coordinatorTeammateId: 'c',
      }),
    });
    expect(edited).toMatchObject({
      id: created.id,
      name: 'Updated party',
      description: 'New description',
      type: 'AD_HOC',
      coordinatorTeammateId: 'c',
      createdAt: created.createdAt,
    });
    expect(memberships.get(created.id)).toEqual([
      { partyId: created.id, teammateId: 'c', role: 'COORDINATOR', order: 0 },
      { partyId: created.id, teammateId: 'a', role: 'MEMBER', order: 1 },
    ]);
    expect(teammates.size).toBe(5);
    expect(teammates.get('a')?.id).toBe('a');
    expect(teammates.get('c')?.id).toBe('c');
  });

  it('returns ordered live members for Mission validation and blocks archived Parties', () => {
    const { service, memberships } = setup();
    const created = service.createParty(input(['b', 'a']));
    const validated = service.validatePartyForMission(created.id);
    expect(validated.party.id).toBe(created.id);
    expect(
      validated.members.map(({ teammate, membership }) => [teammate.id, membership.role]),
    ).toEqual([
      ['b', 'COORDINATOR'],
      ['a', 'MEMBER'],
    ]);
    expect(service.listPartyMembers(created.id)).toEqual(memberships.get(created.id));
    expect(service.archiveParty(created.id).status).toBe('ARCHIVED');
    expect(service.archiveParty(created.id).status).toBe('ARCHIVED');
    expect(() => service.validatePartyForMission(created.id)).toThrow(/已归档 Party/);
    expect(() => service.updateParty({ id: created.id, ...input(['a', 'b']) })).toThrow(
      /已归档 Party 不可编辑/,
    );
  });

  it('fails closed if stored membership loses the Coordinator role invariant', () => {
    const { service, memberships } = setup();
    const party = service.createParty(input(['a', 'b']));
    memberships.set(party.id, [
      { partyId: party.id, teammateId: 'a', role: 'MEMBER', order: 0 },
      { partyId: party.id, teammateId: 'b', role: 'MEMBER', order: 1 },
    ]);
    expect(() => service.validatePartyForMission(party.id)).toThrow(/Coordinator 成员标记无效/);
  });

  it('allows only the runtime-free Human Bridge as a member and never as Coordinator', () => {
    const { service, teammates } = setup();
    const bridge: Teammate = {
      ...teammates.get('e')!,
      id: 'human-bridge',
      name: 'Human Bridge',
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: null,
    };
    teammates.set(bridge.id, bridge);

    const party = service.createParty(input(['a', bridge.id]));

    expect(
      service.validatePartyForMission(party.id).members.map(({ teammate }) => teammate.id),
    ).toEqual(['a', bridge.id]);
    expect(() =>
      service.createParty(input([bridge.id, 'a'], { coordinatorTeammateId: bridge.id })),
    ).toThrow(/只能作为无 Runtime 的 Party 成员/);
    expect(() =>
      service.updateParty({
        id: party.id,
        ...input([bridge.id, 'a'], { coordinatorTeammateId: bridge.id }),
      }),
    ).toThrow(/只能作为无 Runtime 的 Party 成员/);
  });

  it('rejects malformed or runtime-backed USER_BRIDGE members', () => {
    const { service, teammates } = setup();
    const model = teammates.get('e')!;
    const invalidBridge: Teammate = {
      ...model,
      id: 'invalid-bridge',
      executorKind: 'USER_BRIDGE',
      systemKind: null,
      currentRuntimeProfileId: null,
    };
    teammates.set(invalidBridge.id, invalidBridge);
    expect(() => service.createParty(input(['a', invalidBridge.id]))).toThrow(
      /只能作为无 Runtime 的 Party 成员/,
    );

    const runtimeBackedBridge: Teammate = {
      ...invalidBridge,
      id: 'runtime-backed-bridge',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: 'runtime-e',
    };
    teammates.set(runtimeBackedBridge.id, runtimeBackedBridge);
    expect(() => service.createParty(input(['a', runtimeBackedBridge.id]))).toThrow(
      /只能作为无 Runtime 的 Party 成员/,
    );
  });
});
