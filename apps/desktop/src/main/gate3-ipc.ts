import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import { Gate3MissionService } from '@cultivation/application/gate3-mission-service';

const id = z.string().min(1).max(128);
const missionInput = z
  .object({
    title: z.string().min(1).max(120),
    objective: z.string().min(1).max(16_000),
    coordinatorTeammateId: id,
  })
  .strict();
const missionEdit = missionInput.omit({ coordinatorTeammateId: true }).extend({ id }).strict();
const runInput = z.object({ missionId: id, approvalFixture: z.boolean() }).strict();
const approvalDecision = z
  .object({
    approvalId: id,
    decision: z.enum(['APPROVED', 'DENIED', 'ALLOW_MISSION']),
  })
  .strict();

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

  register('missions:list', (args) => {
    noArgs(args);
    return missions.list();
  });
  register('missions:detail', (args) => missions.detail(one(id, args)));
  register('missions:create', (args) => missions.create(one(missionInput, args)));
  register('missions:update', (args) => missions.update(one(missionEdit, args)));
  register('missions:ready', (args) => missions.ready(one(id, args)));
  register('missions:start', (args) => missions.start(one(runInput, args)));
  register('missions:retry', (args) => missions.retry(one(runInput, args)));
  register('missions:pause', (args) => missions.pause(one(id, args)));
  register('missions:resume', (args) => missions.resume(one(id, args)));
  register('missions:cancel', (args) => missions.cancel(one(id, args)));
  register('missions:resolveApproval', (args) =>
    missions.resolveApproval(one(approvalDecision, args)),
  );
}
