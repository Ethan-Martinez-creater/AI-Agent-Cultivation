import Database from 'better-sqlite3';
import type {
  CollaborationArtifact,
  CollaborationRequest,
  CollaborationState,
  Gate5PendingToolCall,
  Mission,
  MissionParticipant,
  Party,
  PartyMember,
} from '@cultivation/domain';

interface PartyRow {
  id: string;
  name: string;
  description: string;
  coordinator_teammate_id: string;
  type: Party['type'];
  status: Party['status'];
  created_at: string;
}

interface PartyMemberRow {
  party_id: string;
  teammate_id: string;
  role: PartyMember['role'];
  sort_order: number;
}

interface MissionParticipantRow {
  mission_id: string;
  teammate_id: string;
  role: MissionParticipant['role'];
  sort_order: number;
}

interface CollaborationRequestRow {
  id: string;
  mission_id: string;
  run_id: string | null;
  requester_teammate_id: string;
  target_teammate_id: string;
  reason: string;
  proposed_task: string;
  expected_benefit: string;
  depth: number;
  state: CollaborationState;
  created_at: string;
  resolved_at: string | null;
}

interface CollaborationArtifactRow {
  id: string;
  mission_id: string;
  run_id: string;
  teammate_id: string;
  kind: CollaborationArtifact['kind'];
  content: string;
  created_at: string;
}

interface Gate5PendingToolCallRow {
  approval_id: string;
  mission_id: string;
  run_id: string;
  teammate_id: string;
  context_json: string;
  step_count: number;
  tool_call_count: number;
  state: Gate5PendingToolCall['state'];
  created_at: string;
  resolved_at: string | null;
}

const MAX_ID_LENGTH = 256;
const MAX_PARTY_NAME_LENGTH = 200;
const MAX_PARTY_DESCRIPTION_LENGTH = 4000;
const MAX_REQUEST_TEXT_LENGTH = 4000;
const MAX_ARTIFACT_BYTES = 65_536;

/** Main-process SQLite persistence for Gate 5 parties and run-scoped collaboration history. */
export class Gate5SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts a Party Mission and its participant snapshot without relaxing Gate 3's SOLO API. */
  insertPartyMission(value: Mission): void {
    validatePartyMission(value, 'DRAFT');
    this.db.transaction(() => {
      const party = this.db
        .prepare('SELECT coordinator_teammate_id, status FROM parties WHERE id = ?')
        .get(value.partyId) as
        | { coordinator_teammate_id: string; status: Party['status'] }
        | undefined;
      if (!party || party.status !== 'ACTIVE')
        throw new Error('Party is unavailable for new Missions');
      if (party.coordinator_teammate_id !== value.coordinatorTeammateId) {
        throw new Error('Mission Coordinator must match the Party Coordinator');
      }
      const members = this.db
        .prepare(
          `SELECT pm.teammate_id, pm.sort_order, pm.role, t.status, t.current_runtime_profile_id,
                  rp.provider_id, p.enabled AS provider_enabled
           FROM party_members AS pm
           JOIN teammates AS t ON t.id = pm.teammate_id
           LEFT JOIN runtime_profiles AS rp ON rp.id = t.current_runtime_profile_id
           LEFT JOIN providers AS p ON p.id = rp.provider_id
           WHERE pm.party_id = ? ORDER BY pm.sort_order, pm.teammate_id`,
        )
        .all(value.partyId) as {
        teammate_id: string;
        sort_order: number;
        role: PartyMember['role'];
        status: string;
        current_runtime_profile_id: string | null;
        provider_id: string | null;
        provider_enabled: number | null;
      }[];
      if (members.length < 2 || members.length > 4) {
        throw new Error('Party Missions require between two and four Teammates');
      }
      if (
        members.some(
          (member) =>
            member.status !== 'ACTIVE' ||
            member.current_runtime_profile_id === null ||
            member.provider_id === null ||
            member.provider_enabled !== 1,
        )
      ) {
        throw new Error('Archived or unavailable Teammates cannot start a Party Mission');
      }
      this.db
        .prepare(
          `INSERT INTO missions
            (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
             party_id, mode, state, created_at, updated_at, completed_at)
           VALUES (@id, @title, @objective, @initiatorType, @initiatorId, @coordinatorTeammateId,
             @partyId, @mode, @state, @createdAt, @updatedAt, @completedAt)`,
        )
        .run(value);
      this.saveMissionParticipants(
        value.id,
        members.map((member) => ({
          missionId: value.id,
          teammateId: member.teammate_id,
          role:
            value.mode === 'REVIEW' &&
            member.teammate_id === members.find((item) => item.role === 'MEMBER')?.teammate_id
              ? 'REVIEWER'
              : member.role,
          sortOrder: member.sort_order,
        })),
      );
    })();
  }

  /** Edits only descriptive fields; Mission state changes stay behind Gate 3's state machine. */
  updatePartyMissionDetails(value: Mission): boolean {
    validatePartyMission(value, value.state);
    if (value.state !== 'DRAFT' && value.state !== 'READY') {
      throw new Error('Only draft or ready Party Missions can be edited');
    }
    return (
      this.db
        .prepare(
          `UPDATE missions SET title = ?, objective = ?, updated_at = ?
           WHERE id = ? AND party_id = ? AND mode = ? AND state IN ('DRAFT', 'READY')
             AND coordinator_teammate_id = ?`,
        )
        .run(
          value.title,
          value.objective,
          value.updatedAt,
          value.id,
          value.partyId,
          value.mode,
          value.coordinatorTeammateId,
        ).changes > 0
    );
  }

  /** Recheck immediately before Mission start to reject archived/unavailable Party members. */
  assertPartyMissionAvailable(missionId: string): void {
    const mission = this.db
      .prepare('SELECT party_id, coordinator_teammate_id FROM missions WHERE id = ?')
      .get(missionId) as { party_id: string | null; coordinator_teammate_id: string } | undefined;
    if (!mission || mission.party_id === null) throw new Error('Mission is not a Party Mission');
    const party = this.db
      .prepare('SELECT coordinator_teammate_id, status FROM parties WHERE id = ?')
      .get(mission.party_id) as
      | { coordinator_teammate_id: string; status: Party['status'] }
      | undefined;
    if (
      !party ||
      party.status !== 'ACTIVE' ||
      party.coordinator_teammate_id !== mission.coordinator_teammate_id
    ) {
      throw new Error('Party is unavailable for a new Mission Run');
    }
    const partyMembers = this.db
      .prepare('SELECT teammate_id FROM party_members WHERE party_id = ? ORDER BY teammate_id')
      .all(mission.party_id) as { teammate_id: string }[];
    const participants = this.db
      .prepare(
        'SELECT teammate_id FROM mission_participants WHERE mission_id = ? ORDER BY teammate_id',
      )
      .all(missionId) as { teammate_id: string }[];
    if (
      partyMembers.length < 2 ||
      partyMembers.length > 4 ||
      partyMembers.map((item) => item.teammate_id).join('\0') !==
        participants.map((item) => item.teammate_id).join('\0')
    ) {
      throw new Error('Party Mission participants no longer match the active Party');
    }
    const activeRuntimeCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM mission_participants AS mp
         JOIN teammates AS t ON t.id = mp.teammate_id
         JOIN runtime_profiles AS rp ON rp.id = t.current_runtime_profile_id
         JOIN providers AS p ON p.id = rp.provider_id AND p.enabled = 1
         WHERE mp.mission_id = ? AND t.status = 'ACTIVE'`,
      )
      .get(missionId) as { count: number };
    if (activeRuntimeCount.count !== partyMembers.length) {
      throw new Error('Archived or unavailable Teammates cannot start a Party Mission');
    }
  }

  listParties(): Party[] {
    return (
      this.db
        .prepare('SELECT * FROM parties ORDER BY status, name COLLATE NOCASE, id')
        .all() as PartyRow[]
    ).map(mapParty);
  }

  getParty(id: string): Party | null {
    const row = this.db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as
      | PartyRow
      | undefined;
    return row ? mapParty(row) : null;
  }

  listPartyMembers(partyId: string): PartyMember[] {
    return (
      this.db
        .prepare('SELECT * FROM party_members WHERE party_id = ? ORDER BY sort_order, teammate_id')
        .all(partyId) as PartyMemberRow[]
    ).map(mapPartyMember);
  }

  /** Atomically upserts a Party and replaces its ordered membership snapshot. */
  saveParty(party: Party, members: PartyMember[]): void {
    validateParty(party, members);
    this.db.transaction(() => {
      const existingCoordinator = this.db
        .prepare('SELECT coordinator_teammate_id FROM parties WHERE id = ?')
        .get(party.id) as { coordinator_teammate_id: string } | undefined;
      if (
        existingCoordinator &&
        existingCoordinator.coordinator_teammate_id !== party.coordinatorTeammateId
      ) {
        // Remove the old ordered rows before the coordinator row changes. The transaction makes
        // this replacement atomic to readers.
        this.db.prepare('DELETE FROM party_members WHERE party_id = ?').run(party.id);
      }
      this.db
        .prepare(
          `INSERT INTO parties
            (id, name, description, coordinator_teammate_id, type, status, created_at)
           VALUES (@id, @name, @description, @coordinatorTeammateId, @type, @status, @createdAt)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, description = excluded.description,
             coordinator_teammate_id = excluded.coordinator_teammate_id,
             type = excluded.type, status = excluded.status`,
        )
        .run({
          id: party.id,
          name: party.name,
          description: party.description,
          coordinatorTeammateId: party.coordinatorTeammateId,
          type: party.type,
          status: party.status,
          createdAt: party.createdAt,
        });

      this.db.prepare('DELETE FROM party_members WHERE party_id = ?').run(party.id);
      const insertMember = this.db.prepare(
        `INSERT INTO party_members (party_id, teammate_id, role, sort_order)
         VALUES (@partyId, @teammateId, @role, @order)`,
      );
      for (const member of members) insertMember.run(member);
    })();
  }

  archiveParty(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE parties SET status = 'ARCHIVED' WHERE id = ? AND status != 'ARCHIVED'")
        .run(id).changes > 0
    );
  }

  listMissionParticipants(missionId: string): MissionParticipant[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM mission_participants WHERE mission_id = ? ORDER BY sort_order, teammate_id',
        )
        .all(missionId) as MissionParticipantRow[]
    ).map(mapMissionParticipant);
  }

  /** Assigns participants before the first Run, preserving the Mission's Party as its source. */
  saveMissionParticipants(missionId: string, participants: MissionParticipant[]): void {
    validateParticipants(missionId, participants);
    this.db.transaction(() => {
      const mission = this.db
        .prepare('SELECT coordinator_teammate_id, party_id, state FROM missions WHERE id = ?')
        .get(missionId) as
        | { coordinator_teammate_id: string; party_id: string | null; state: string }
        | undefined;
      if (!mission) throw new Error('Mission does not exist');
      if (mission.state !== 'DRAFT' && mission.state !== 'READY') {
        throw new Error('Mission participants can only change before execution');
      }
      if (this.db.prepare('SELECT 1 FROM mission_runs WHERE mission_id = ?').get(missionId)) {
        throw new Error('Mission participants are immutable after a Run has been created');
      }
      const coordinator = participants.find((participant) => participant.role === 'COORDINATOR');
      if (!coordinator || coordinator.teammateId !== mission.coordinator_teammate_id) {
        throw new Error('Mission participants must include the configured Coordinator');
      }
      if (mission.party_id !== null) {
        if (participants.length < 2 || participants.length > 4) {
          throw new Error('Party Missions require between two and four participants');
        }
        const partyMembers = this.db
          .prepare('SELECT teammate_id FROM party_members WHERE party_id = ? ORDER BY teammate_id')
          .all(mission.party_id) as { teammate_id: string }[];
        const participantIds = participants.map((participant) => participant.teammateId).sort();
        if (
          participantIds.join('\0') !== partyMembers.map((member) => member.teammate_id).join('\0')
        ) {
          throw new Error('Mission participants must match the selected Party membership');
        }
        const activeCount = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM teammates
             WHERE id IN (${participants.map(() => '?').join(',')}) AND status = 'ACTIVE'`,
          )
          .get(...participantIds) as { count: number };
        if (activeCount.count !== participants.length) {
          throw new Error('Archived Teammates cannot start a new Party Mission');
        }
      } else if (participants.length !== 1) {
        throw new Error('SOLO Missions require exactly one participant');
      }

      this.db.prepare('DELETE FROM mission_participants WHERE mission_id = ?').run(missionId);
      const insert = this.db.prepare(
        `INSERT INTO mission_participants (mission_id, teammate_id, role, sort_order)
         VALUES (@missionId, @teammateId, @role, @sortOrder)`,
      );
      for (const participant of participants) insert.run(participant);
      if (mission.party_id !== null) this.assertPartyMissionAvailable(missionId);
    })();
  }

  createCollaborationRequest(value: CollaborationRequest): void {
    validateCollaborationRequest(value);
    this.db
      .prepare(
        `INSERT INTO collaboration_requests
          (id, mission_id, run_id, requester_teammate_id, target_teammate_id, reason,
           proposed_task, expected_benefit, depth, state, created_at, resolved_at)
         VALUES (@id, @missionId, @runId, @requesterTeammateId, @targetTeammateId, @reason,
           @proposedTask, @expectedBenefit, @depth, @state, @createdAt, @resolvedAt)`,
      )
      .run(value);
  }

  getCollaborationRequest(id: string): CollaborationRequest | null {
    const row = this.db.prepare('SELECT * FROM collaboration_requests WHERE id = ?').get(id) as
      | CollaborationRequestRow
      | undefined;
    return row ? mapCollaborationRequest(row) : null;
  }

  listCollaborationRequests(missionId: string): CollaborationRequest[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM collaboration_requests WHERE mission_id = ? ORDER BY created_at, id',
        )
        .all(missionId) as CollaborationRequestRow[]
    ).map(mapCollaborationRequest);
  }

  /** Resolves a CollaborationRequest exactly once; returns null if another decision won. */
  resolveCollaborationRequest(
    id: string,
    decision: Extract<CollaborationState, 'APPROVED' | 'DENIED' | 'CANCELLED'>,
    resolvedAt: string,
  ): CollaborationRequest | null {
    if (!isNonEmptyString(resolvedAt, 128))
      throw new Error('Invalid collaboration resolution time');
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE collaboration_requests SET state = ?, resolved_at = ?
           WHERE id = ? AND state = 'PENDING' AND resolved_at IS NULL`,
        )
        .run(decision, resolvedAt, id).changes;
      if (changed === 0) return null;
      return this.getCollaborationRequest(id);
    })();
  }

  appendCollaborationArtifact(value: CollaborationArtifact): void {
    validateCollaborationArtifact(value);
    this.db
      .prepare(
        `INSERT INTO collaboration_artifacts
          (id, mission_id, run_id, teammate_id, kind, content, created_at)
         VALUES (@id, @missionId, @runId, @teammateId, @kind, @content, @createdAt)`,
      )
      .run(value);
  }

  listCollaborationArtifacts(missionId: string, runId?: string): CollaborationArtifact[] {
    const rows = runId
      ? (this.db
          .prepare(
            `SELECT * FROM collaboration_artifacts
             WHERE mission_id = ? AND run_id = ? ORDER BY created_at, rowid`,
          )
          .all(missionId, runId) as CollaborationArtifactRow[])
      : (this.db
          .prepare(
            'SELECT * FROM collaboration_artifacts WHERE mission_id = ? ORDER BY created_at, rowid',
          )
          .all(missionId) as CollaborationArtifactRow[]);
    return rows.map(mapCollaborationArtifact);
  }

  saveGate5PendingToolCall(value: Gate5PendingToolCall): void {
    validateGate5PendingToolCall(value);
    this.db
      .prepare(
        `INSERT INTO gate5_pending_tool_calls
          (approval_id, mission_id, run_id, teammate_id, context_json,
           step_count, tool_call_count, state, created_at, resolved_at)
         VALUES (@approvalId, @missionId, @runId, @teammateId, @contextJson,
           @stepCount, @toolCallCount, @state, @createdAt, @resolvedAt)`,
      )
      .run(value);
  }

  getGate5PendingToolCall(approvalId: string): Gate5PendingToolCall | null {
    const row = this.db
      .prepare('SELECT * FROM gate5_pending_tool_calls WHERE approval_id = ?')
      .get(approvalId) as Gate5PendingToolCallRow | undefined;
    return row ? mapGate5PendingToolCall(row) : null;
  }

  /** Resolves one continuation exactly once; a repeated decision returns null. */
  resolveGate5PendingToolCall(approvalId: string, at: string): Gate5PendingToolCall | null {
    if (!isNonEmptyString(at, 128)) throw new Error('Invalid Gate 5 pending tool resolution time');
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE gate5_pending_tool_calls SET state = 'RESOLVED', resolved_at = ?
           WHERE approval_id = ? AND state = 'PENDING' AND resolved_at IS NULL`,
        )
        .run(at, approvalId).changes;
      if (changed === 0) return null;
      return this.getGate5PendingToolCall(approvalId);
    })();
  }
}

function mapParty(row: PartyRow): Party {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    coordinatorTeammateId: row.coordinator_teammate_id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapPartyMember(row: PartyMemberRow): PartyMember {
  return {
    partyId: row.party_id,
    teammateId: row.teammate_id,
    role: row.role,
    order: row.sort_order,
  };
}

function mapMissionParticipant(row: MissionParticipantRow): MissionParticipant {
  return {
    missionId: row.mission_id,
    teammateId: row.teammate_id,
    role: row.role,
    sortOrder: row.sort_order,
  };
}

function mapCollaborationRequest(row: CollaborationRequestRow): CollaborationRequest {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    requesterTeammateId: row.requester_teammate_id,
    targetTeammateId: row.target_teammate_id,
    reason: row.reason,
    proposedTask: row.proposed_task,
    expectedBenefit: row.expected_benefit,
    depth: row.depth as 0 | 1,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapCollaborationArtifact(row: CollaborationArtifactRow): CollaborationArtifact {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    teammateId: row.teammate_id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapGate5PendingToolCall(row: Gate5PendingToolCallRow): Gate5PendingToolCall {
  return {
    approvalId: row.approval_id,
    missionId: row.mission_id,
    runId: row.run_id,
    teammateId: row.teammate_id,
    contextJson: row.context_json,
    stepCount: row.step_count,
    toolCallCount: row.tool_call_count,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function validateParty(party: Party, members: PartyMember[]): void {
  if (!isNonEmptyString(party.id, MAX_ID_LENGTH)) throw new Error('Invalid Party id');
  if (!isNonEmptyString(party.name, MAX_PARTY_NAME_LENGTH)) throw new Error('Invalid Party name');
  if (!isString(party.description, MAX_PARTY_DESCRIPTION_LENGTH))
    throw new Error('Invalid Party description');
  if (party.type !== 'FIXED' && party.type !== 'AD_HOC') throw new Error('Invalid Party type');
  if (party.status !== 'ACTIVE' && party.status !== 'ARCHIVED')
    throw new Error('Invalid Party status');
  if (!isNonEmptyString(party.createdAt, 128)) throw new Error('Invalid Party timestamp');
  if (!Array.isArray(members) || members.length < 2 || members.length > 4) {
    throw new Error('A Party must contain between two and four Teammates');
  }
  const memberIds = new Set<string>();
  const orders = new Set<number>();
  let coordinatorCount = 0;
  for (const member of members) {
    if (member.partyId !== party.id) throw new Error('Party member references a different Party');
    if (!isNonEmptyString(member.teammateId, MAX_ID_LENGTH) || memberIds.has(member.teammateId)) {
      throw new Error('Party Teammates must be unique');
    }
    memberIds.add(member.teammateId);
    if (!Number.isSafeInteger(member.order) || member.order < 0 || orders.has(member.order)) {
      throw new Error('Party member order must be a unique non-negative integer');
    }
    orders.add(member.order);
    if (member.role === 'COORDINATOR') {
      coordinatorCount += 1;
      if (member.teammateId !== party.coordinatorTeammateId) {
        throw new Error('Party Coordinator role must match coordinatorTeammateId');
      }
    } else if (member.role !== 'MEMBER') {
      throw new Error('Invalid Party member role');
    }
  }
  if (coordinatorCount !== 1 || !memberIds.has(party.coordinatorTeammateId)) {
    throw new Error('A Party must include exactly one designated Coordinator');
  }
}

function validatePartyMission(value: Mission, requestedState: Mission['state']): void {
  if (!isNonEmptyString(value.id, MAX_ID_LENGTH)) throw new Error('Invalid Mission id');
  if (!isNonEmptyString(value.title, 400)) throw new Error('Invalid Mission title');
  if (!isNonEmptyString(value.objective, 32_000)) throw new Error('Invalid Mission objective');
  if (value.initiatorType !== 'USER' && value.initiatorType !== 'TEAMMATE') {
    throw new Error('Invalid Mission initiator');
  }
  if (!isNonEmptyString(value.initiatorId, MAX_ID_LENGTH))
    throw new Error('Invalid Mission initiator id');
  if (!isNonEmptyString(value.coordinatorTeammateId, MAX_ID_LENGTH)) {
    throw new Error('Invalid Mission Coordinator');
  }
  if (!isNonEmptyString(value.partyId, MAX_ID_LENGTH))
    throw new Error('Party Mission requires a Party');
  if (!['CONSULTATION', 'REVIEW', 'DELEGATION'].includes(value.mode)) {
    throw new Error('Party Mission mode must be a collaboration mode');
  }
  if (requestedState !== 'DRAFT' && requestedState !== 'READY') {
    throw new Error('Party Mission must be in DRAFT or READY state');
  }
  if (value.state !== requestedState) throw new Error('Invalid Party Mission initial state');
  if (value.completedAt !== null)
    throw new Error('A new or editable Party Mission cannot be completed');
  if (!isNonEmptyString(value.createdAt, 128) || !isNonEmptyString(value.updatedAt, 128)) {
    throw new Error('Invalid Mission timestamps');
  }
}

function validateParticipants(missionId: string, participants: MissionParticipant[]): void {
  if (!isNonEmptyString(missionId, MAX_ID_LENGTH)) throw new Error('Invalid Mission id');
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > 4) {
    throw new Error('A Mission must contain between one and four participants');
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  let coordinators = 0;
  for (const participant of participants) {
    if (participant.missionId !== missionId)
      throw new Error('Participant references a different Mission');
    if (
      !isNonEmptyString(participant.teammateId, MAX_ID_LENGTH) ||
      ids.has(participant.teammateId)
    ) {
      throw new Error('Mission participants must be unique');
    }
    ids.add(participant.teammateId);
    if (!['COORDINATOR', 'MEMBER', 'AUTHOR', 'REVIEWER'].includes(participant.role)) {
      throw new Error('Invalid Mission participant role');
    }
    if (
      !Number.isSafeInteger(participant.sortOrder) ||
      participant.sortOrder < 0 ||
      orders.has(participant.sortOrder)
    ) {
      throw new Error('Participant order must be a unique non-negative integer');
    }
    orders.add(participant.sortOrder);
    if (participant.role === 'COORDINATOR') coordinators += 1;
  }
  if (coordinators !== 1) throw new Error('A Mission must include exactly one Coordinator');
}

function validateCollaborationRequest(value: CollaborationRequest): void {
  if (!isNonEmptyString(value.id, MAX_ID_LENGTH))
    throw new Error('Invalid CollaborationRequest id');
  if (!isNonEmptyString(value.missionId, MAX_ID_LENGTH)) throw new Error('Invalid Mission id');
  if (!isNonEmptyString(value.runId, MAX_ID_LENGTH))
    throw new Error('CollaborationRequest must be linked to a Mission Run');
  if (!isNonEmptyString(value.requesterTeammateId, MAX_ID_LENGTH))
    throw new Error('Invalid requester Teammate');
  if (!isNonEmptyString(value.targetTeammateId, MAX_ID_LENGTH))
    throw new Error('Invalid target Teammate');
  if (value.requesterTeammateId === value.targetTeammateId)
    throw new Error('A Teammate cannot invite itself');
  if (!isNonEmptyString(value.reason, MAX_REQUEST_TEXT_LENGTH))
    throw new Error('Invalid collaboration reason');
  if (!isNonEmptyString(value.proposedTask, MAX_REQUEST_TEXT_LENGTH))
    throw new Error('Invalid collaboration task');
  if (!isNonEmptyString(value.expectedBenefit, MAX_REQUEST_TEXT_LENGTH))
    throw new Error('Invalid expected benefit');
  if (!Number.isSafeInteger(value.depth) || (value.depth !== 0 && value.depth !== 1)) {
    throw new Error('Collaboration depth is limited to zero or one');
  }
  if (value.state !== 'PENDING' || value.resolvedAt !== null) {
    throw new Error('New CollaborationRequests must be pending');
  }
  if (!isNonEmptyString(value.createdAt, 128))
    throw new Error('Invalid CollaborationRequest timestamp');
}

function validateCollaborationArtifact(value: CollaborationArtifact): void {
  if (!isNonEmptyString(value.id, MAX_ID_LENGTH)) throw new Error('Invalid artifact id');
  if (!isNonEmptyString(value.missionId, MAX_ID_LENGTH)) throw new Error('Invalid Mission id');
  if (!isNonEmptyString(value.runId, MAX_ID_LENGTH)) throw new Error('Invalid Mission Run id');
  if (!isNonEmptyString(value.teammateId, MAX_ID_LENGTH))
    throw new Error('Invalid artifact Teammate');
  if (!['MEMBER_RESULT', 'DRAFT', 'REVIEW', 'FINAL'].includes(value.kind)) {
    throw new Error('Invalid collaboration artifact kind');
  }
  if (!isString(value.content, MAX_ARTIFACT_BYTES))
    throw new Error('Collaboration artifact exceeds the size limit');
  if (!isNonEmptyString(value.createdAt, 128)) throw new Error('Invalid artifact timestamp');
}

function validateGate5PendingToolCall(value: Gate5PendingToolCall): void {
  if (!isNonEmptyString(value.approvalId, MAX_ID_LENGTH)) throw new Error('Invalid approval id');
  if (!isNonEmptyString(value.missionId, MAX_ID_LENGTH)) throw new Error('Invalid Mission id');
  if (!isNonEmptyString(value.runId, MAX_ID_LENGTH)) throw new Error('Invalid Mission Run id');
  if (!isNonEmptyString(value.teammateId, MAX_ID_LENGTH)) throw new Error('Invalid Teammate id');
  if (!isString(value.contextJson, 3 * 1024 * 1024))
    throw new Error('Gate 5 continuation context is too large');
  try {
    const parsed: unknown = JSON.parse(value.contextJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gate 5 continuation context must be a JSON object');
    }
  } catch {
    throw new Error('Gate 5 continuation context must be a JSON object');
  }
  if (!Number.isSafeInteger(value.stepCount) || value.stepCount < 0) {
    throw new Error('Invalid Gate 5 step count');
  }
  if (!Number.isSafeInteger(value.toolCallCount) || value.toolCallCount < 0) {
    throw new Error('Invalid Gate 5 tool call count');
  }
  if (value.state !== 'PENDING' || value.resolvedAt !== null) {
    throw new Error('New Gate 5 pending calls must be unresolved');
  }
  if (!isNonEmptyString(value.createdAt, 128))
    throw new Error('Invalid Gate 5 pending call timestamp');
}

function isNonEmptyString(value: unknown, maxBytes: number): value is string {
  return isString(value, maxBytes) && value.trim().length > 0;
}

function isString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}
