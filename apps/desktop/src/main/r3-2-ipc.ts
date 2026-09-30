import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import type { AvailabilityService } from '@cultivation/application';
import type { Gate1Service } from '@cultivation/application/gate1-service';

export function registerAvailabilityIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  availability: AvailabilityService,
  teammates: Pick<Gate1Service, 'listTeammates'>,
): void {
  const id = z.string().min(1).max(128);
  for (const channel of ['availability:list', 'availability:recheck', 'availability:prepare']) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        if (channel === 'availability:list') {
          z.tuple([]).parse(args);
          return teammates.listTeammates().flatMap((teammate) => {
            const state = availability.get(teammate.id);
            return state ? [state] : [];
          });
        }
        const [teammateId] = z.tuple([id]).parse(args);
        if (channel === 'availability:recheck') return await availability.recheck(teammateId);
        const teammate = teammates.listTeammates().find((row) => row.id === teammateId);
        if (!teammate?.currentRuntimeProfileId || teammate.executorKind !== 'MODEL_RUNTIME')
          throw new DomainError('INVALID_INPUT', '此道友没有模型绑定');
        return await availability.prepare({
          teammateId,
          runtimeProfileId: teammate.currentRuntimeProfileId,
        });
      } catch (error) {
        throw new Error(error instanceof DomainError ? error.message : '可用性操作失败，请重试');
      }
    });
  }
}
