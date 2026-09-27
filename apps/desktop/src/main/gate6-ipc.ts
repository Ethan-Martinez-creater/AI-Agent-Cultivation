import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { Gate6ExperienceService } from '@cultivation/application/gate6-experience-service';

const teammateId = z.string().min(1).max(128);

export function registerGate6Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  experience: Gate6ExperienceService,
): void {
  ipcMain.removeHandler('experience:get');
  ipcMain.handle('experience:get', (event, ...args: unknown[]) => {
    if (!validSender(event)) throw new Error('IPC sender denied');
    if (args.length !== 1) throw new Error('请求参数无效');
    const parsed = teammateId.safeParse(args[0]);
    if (!parsed.success) throw new Error('请求参数无效');
    try {
      return experience.get(parsed.data);
    } catch {
      throw new Error('读取道友经历失败');
    }
  });
}
