import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import type { MissionMode } from '@cultivation/domain';
import type {
  Gate3MissionService,
  Gate3MissionStore,
  MissionDetail,
} from '@cultivation/application/gate3-mission-service';
import type { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import type { Gate5PartyService } from '@cultivation/application/gate5-party-service';

const id = z.string().min(1).max(128);
const missionInput = z
  .object({
    title: z.string().min(1).max(120),
    objective: z.string().min(1).max(8_000),
    coordinatorTeammateId: id,
    mode: z.enum(['SOLO', 'CONSULTATION', 'REVIEW', 'DELEGATION']).optional(),
    partyId: id.nullable().optional(),
  })
  .strict();
const missionEdit = z
  .object({ id, title: z.string().min(1).max(120), objective: z.string().min(1).max(8_000) })
  .strict();
const runInput = z.object({ missionId: id, approvalFixture: z.boolean() }).strict();
const approvalDecision = z
  .object({
    approvalId: id,
    decision: z.enum(['APPROVED', 'DENIED', 'ALLOW_MISSION']),
  })
  .strict();
const collaborationDecision = z
  .object({
    requestId: id,
    decision: z.enum(['APPROVED', 'DENIED']),
    externalWork: z.object({
      capability: z.enum([
        'GENERAL_REASONING', 'LONG_CONTEXT_REASONING', 'AGENTIC_EXECUTION', 'CODING', 'TOOL_USE',
        'VISUAL_UNDERSTANDING', 'IMAGE_GENERATION', 'IMAGE_EDITING', 'VIDEO_GENERATION', 'VIDEO_EDITING',
        'SPEECH_UNDERSTANDING', 'SPEECH_GENERATION', 'SPEECH_TO_SPEECH', 'MUSIC_GENERATION',
      ]),
      title: z.string().min(1).max(160),
      prompt: z.string().min(1).max(20_000),
      requirements: z.array(z.string().min(1).max(1_000)).max(20),
      targetArtifacts: z.array(z.object({
        id, name: z.string().min(1).max(255), required: z.boolean(),
        allowedExtensions: z.array(z.string().regex(/^\.[a-z0-9]{1,12}$/)).min(1).max(16),
        maxSizeBytes: z.number().int().min(1).max(100 * 1024 * 1024),
      }).strict()).min(1).max(12),
      targetWorkspacePaths: z.array(z.string().min(1).max(512)).max(8),
      acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
      externalAppProfileId: id.nullable().optional(),
    }).strict().optional(),
  })
  .strict();
const partyInput = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2_000),
    type: z.enum(['FIXED', 'AD_HOC']),
    coordinatorTeammateId: id,
    memberTeammateIds: z.array(id).min(2).max(4),
  })
  .strict();
const partyUpdate = partyInput.extend({ id }).strict();

function one<T>(schema: z.ZodType<T>, args: unknown[]): T {
  if (args.length !== 1) throw new DomainError('INVALID_INPUT', '请求参数无效');
  const parsed = schema.safeParse(args[0]);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', '请求参数无效');
  return parsed.data;
}

function noArgs(args: unknown[]): void {
  if (args.length !== 0) throw new DomainError('INVALID_INPUT', '请求参数无效');
}

function publicError(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return 'Mission 操作失败，请检查状态后重试';
}

export function registerGate3Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  missions: Gate3MissionService,
  missionStore: Pick<Gate3MissionStore, 'getApproval'>,
  partyMissions: Gate5CollaborationService,
  parties: Gate5PartyService,
): void {
  const register = (
    channel: string,
    handler: (args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handler(args);
      } catch (error) {
        throw new Error(publicError(error));
      }
    });
  };

  const isPartyMission = (missionId: string): boolean =>
    missions.detail(missionId).mission.mode !== 'SOLO';
  const detail = (missionId: string) => {
    if (isPartyMission(missionId)) return partyMissions.detail(missionId);
    return {
      ...missions.detail(missionId),
      participants: [],
      collaborations: [],
      artifacts: [],
    };
  };
  const partyView = (partyId: string) => ({
    ...parties.getParty(partyId),
    members: parties.listPartyMembers(partyId),
  });
  const isPartyApproval = (approvalId: string): boolean => {
    const approval = missionStore.getApproval(approvalId);
    return approval ? isPartyMission(approval.missionId) : false;
  };

  register('missions:list', (args) => {
    noArgs(args);
    return missions.list();
  });
  register('missions:detail', (args) => detail(one(id, args)));
  register('missions:create', (args) => {
    const input = one(missionInput, args);
    const mode: MissionMode = input.mode ?? 'SOLO';
    if (mode === 'SOLO') {
      if (input.partyId) throw new DomainError('INVALID_INPUT', 'SOLO Mission 不可指定 Party');
      return missions.create({
        title: input.title,
        objective: input.objective,
        coordinatorTeammateId: input.coordinatorTeammateId,
      });
    }
    if (!input.partyId) throw new DomainError('INVALID_INPUT', 'Party Mission 必须指定 Party');
    const party = parties.getParty(input.partyId);
    if (party.coordinatorTeammateId !== input.coordinatorTeammateId) {
      throw new DomainError('INVALID_INPUT', 'Mission 协调道友必须与 Party Coordinator 一致');
    }
    return partyMissions.create({
      title: input.title,
      objective: input.objective,
      mode,
      partyId: input.partyId,
    });
  });
  register('missions:update', (args) => {
    const input = one(missionEdit, args);
    return isPartyMission(input.id) ? partyMissions.update(input) : missions.update(input);
  });
  register('missions:ready', (args) => {
    const missionId = one(id, args);
    return isPartyMission(missionId) ? partyMissions.ready(missionId) : missions.ready(missionId);
  });
  register('missions:start', async (args) => {
    const input = one(runInput, args);
    return isPartyMission(input.missionId)
      ? partyMissions.start(input.missionId)
      : detailAfter(missions.start(input));
  });
  register('missions:retry', async (args) => {
    const input = one(runInput, args);
    return isPartyMission(input.missionId)
      ? partyMissions.retry(input.missionId)
      : detailAfter(missions.retry(input));
  });
  register('missions:pause', (args) => {
    const missionId = one(id, args);
    return isPartyMission(missionId) ? partyMissions.pause(missionId) : missions.pause(missionId);
  });
  register('missions:resume', async (args) => {
    const missionId = one(id, args);
    return isPartyMission(missionId)
      ? partyMissions.resume(missionId)
      : detailAfter(missions.resume(missionId));
  });
  register('missions:cancel', (args) => {
    const missionId = one(id, args);
    return isPartyMission(missionId) ? partyMissions.cancel(missionId) : missions.cancel(missionId);
  });
  register('missions:resolveApproval', async (args) => {
    const input = one(approvalDecision, args);
    if (isPartyApproval(input.approvalId)) return partyMissions.resolveToolApproval(input);
    return detailAfter(missions.resolveApproval(input));
  });
  register('missions:resolveCollaboration', (args) =>
    partyMissions.resolveCollaboration(one(collaborationDecision, args)),
  );

  register('parties:list', (args) => {
    noArgs(args);
    return parties.listParties().map((party) => partyView(party.id));
  });
  register('parties:create', (args) => {
    const created = parties.createParty(one(partyInput, args));
    return partyView(created.id);
  });
  register('parties:update', (args) => {
    const updated = parties.updateParty(one(partyUpdate, args));
    return partyView(updated.id);
  });
  register('parties:archive', (args) => partyView(parties.archiveParty(one(id, args)).id));

  async function detailAfter(result: Promise<MissionDetail>): Promise<unknown> {
    const resolved = await result;
    return { ...resolved, participants: [], collaborations: [], artifacts: [] };
  }
}
