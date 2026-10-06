import type { Party, PartyMember, PartyType, RuntimeProfile, Teammate } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';

/**
 * Persistence port for Party and ordered membership. saveParty must replace the Party's complete
 * member set atomically so callers never observe a Party without its Coordinator.
 */
export interface Gate5PartyStore {
  listParties(): Party[];
  getParty(id: string): Party | null;
  listPartyMembers(partyId: string): PartyMember[];
  saveParty(party: Party, members: PartyMember[]): void;
}

/** Narrow view over the existing persistent Teammate and RuntimeProfile records. */
export interface Gate5PartyTeammateStore {
  getTeammate(id: string): Teammate | null;
  getRuntimeProfile(id: string): RuntimeProfile | null;
}

export interface PartyMemberWithTeammate {
  membership: PartyMember;
  teammate: Teammate;
}

export interface ValidatedPartyForMission {
  party: Party;
  members: PartyMemberWithTeammate[];
}

export interface PartyInput {
  name: string;
  description: string;
  type: PartyType;
  coordinatorTeammateId: string;
  memberTeammateIds: string[];
}

export interface UpdatePartyInput extends PartyInput {
  id: string;
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new DomainError('INVALID_INPUT', `${label}不能为空`);
  return result;
}

function notFound(label: string): never {
  throw new DomainError('NOT_FOUND', `${label}不存在`);
}

function validateType(type: PartyType): void {
  if (type !== 'FIXED' && type !== 'AD_HOC') {
    throw new DomainError('INVALID_INPUT', 'Party 类型无效');
  }
}

export class Gate5PartyService {
  constructor(
    private readonly parties: Gate5PartyStore,
    private readonly teammates: Gate5PartyTeammateStore,
  ) {}

  listParties(): Party[] {
    return this.parties.listParties();
  }

  getParty(partyId: string): Party {
    const party = this.parties.getParty(partyId);
    if (!party) notFound('Party');
    return party;
  }

  listPartyMembers(partyId: string): PartyMember[] {
    this.getParty(partyId);
    return this.parties.listPartyMembers(partyId);
  }

  createParty(input: PartyInput): Party {
    const party = this.newParty(input);
    const members = this.membersFor(party.id, input);
    this.assertAllAvailable(members);
    this.parties.saveParty(party, members);
    return party;
  }

  updateParty(input: UpdatePartyInput): Party {
    const previous = this.parties.getParty(input.id);
    if (!previous) notFound('Party');
    if (previous.status !== 'ACTIVE') {
      throw new DomainError('INVALID_INPUT', '已归档 Party 不可编辑');
    }
    const members = this.membersFor(input.id, input);
    this.assertAllAvailable(members);
    const party: Party = {
      ...previous,
      name: required(input.name, 'Party 名称'),
      description: input.description.trim(),
      type: input.type,
      coordinatorTeammateId: input.coordinatorTeammateId,
    };
    this.parties.saveParty(party, members);
    return party;
  }

  archiveParty(partyId: string): Party {
    const previous = this.parties.getParty(partyId);
    if (!previous) notFound('Party');
    if (previous.status === 'ARCHIVED') return previous;
    const archived: Party = { ...previous, status: 'ARCHIVED' };
    this.parties.saveParty(archived, this.parties.listPartyMembers(partyId));
    return archived;
  }

  /**
   * Re-checks live availability immediately before Mission creation/start. Party membership is
   * only a saved roster: it never creates a Teammate or a hidden Coordinator agent.
   */
  validatePartyForMission(partyId: string): ValidatedPartyForMission {
    const party = this.getParty(partyId);
    if (party.status !== 'ACTIVE') {
      throw new DomainError('INVALID_INPUT', '已归档 Party 不可用于新 Mission');
    }
    const memberships = [...this.parties.listPartyMembers(partyId)].sort(
      (a, b) => a.order - b.order,
    );
    this.assertRoster(party, memberships);
    const members = memberships.map((membership): PartyMemberWithTeammate => {
      const teammate = this.requireAvailableTeammate(membership.teammateId, membership.role);
      return { membership, teammate };
    });
    return { party, members };
  }

  private newParty(input: PartyInput): Party {
    validateType(input.type);
    return {
      id: id(),
      name: required(input.name, 'Party 名称'),
      description: input.description.trim(),
      coordinatorTeammateId: required(input.coordinatorTeammateId, 'Coordinator'),
      type: input.type,
      status: 'ACTIVE',
      createdAt: now(),
    };
  }

  private membersFor(partyId: string, input: PartyInput): PartyMember[] {
    validateType(input.type);
    const ids = input.memberTeammateIds.map((teammateId) => required(teammateId, '成员道友'));
    if (ids.length < 2 || ids.length > 4) {
      throw new DomainError('INVALID_INPUT', 'Party 必须包含 2 至 4 名道友');
    }
    if (new Set(ids).size !== ids.length) {
      throw new DomainError('INVALID_INPUT', 'Party 成员不可重复');
    }
    if (!ids.includes(input.coordinatorTeammateId)) {
      throw new DomainError('INVALID_INPUT', 'Coordinator 必须是 Party 成员');
    }
    return ids.map((teammateId, order) => ({
      partyId,
      teammateId,
      role: teammateId === input.coordinatorTeammateId ? 'COORDINATOR' : 'MEMBER',
      order,
    }));
  }

  private assertRoster(party: Party, members: PartyMember[]): void {
    const teammateIds = members.map((member) => member.teammateId);
    if (
      members.length < 2 ||
      members.length > 4 ||
      new Set(teammateIds).size !== members.length ||
      members.some((member) => member.partyId !== party.id) ||
      !teammateIds.includes(party.coordinatorTeammateId)
    ) {
      throw new DomainError('INVALID_INPUT', 'Party 成员配置无效');
    }
    const coordinatorRows = members.filter((member) => member.role === 'COORDINATOR');
    if (
      coordinatorRows.length !== 1 ||
      coordinatorRows[0]?.teammateId !== party.coordinatorTeammateId ||
      members.some(
        (member) =>
          member.role !==
          (member.teammateId === party.coordinatorTeammateId ? 'COORDINATOR' : 'MEMBER'),
      )
    ) {
      throw new DomainError('INVALID_INPUT', 'Party Coordinator 成员标记无效');
    }
  }

  private assertAllAvailable(members: PartyMember[]): void {
    for (const member of members) {
      this.requireAvailableTeammate(member.teammateId, member.role);
    }
  }

  private requireAvailableTeammate(teammateId: string, role: PartyMember['role']): Teammate {
    const teammate = this.teammates.getTeammate(teammateId);
    if (!teammate || teammate.status !== 'ACTIVE') {
      throw new DomainError('INVALID_INPUT', 'Party 包含不可用或已归档的道友');
    }
    if (teammate.executorKind === 'USER_BRIDGE') {
      if (
        role === 'COORDINATOR' ||
        teammate.systemKind !== 'HUMAN_BRIDGE' ||
        teammate.currentRuntimeProfileId !== null
      ) {
        throw new DomainError('INVALID_INPUT', 'Human Bridge 只能作为无 Runtime 的 Party 成员');
      }
      return teammate;
    }
    if (
      teammate.executorKind !== 'MODEL_RUNTIME' ||
      teammate.systemKind !== null ||
      !teammate.currentRuntimeProfileId
    ) {
      throw new DomainError('INVALID_INPUT', 'Party 包含不可用或已归档的道友');
    }
    const runtime = this.teammates.getRuntimeProfile(teammate.currentRuntimeProfileId);
    if (!runtime) {
      throw new DomainError('INVALID_INPUT', 'Party 成员的运行配置不可用');
    }
    if (role === 'COORDINATOR' && (runtime.executionProtocol ?? 'LANGUAGE') !== 'LANGUAGE')
      throw new DomainError('INVALID_INPUT', '队伍协调道友必须使用文本模型');
    return teammate;
  }
}
