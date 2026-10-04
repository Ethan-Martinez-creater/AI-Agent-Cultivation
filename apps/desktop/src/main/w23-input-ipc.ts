import { ipcMain, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { ResearchInputArtifactService } from './w23-input-artifacts.js';
export function registerResearchInputIpc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: ResearchInputArtifactService,
): void {
  ipcMain.removeHandler('workflows:inputCandidates');
  ipcMain.removeHandler('workflows:importInput');
  ipcMain.handle('workflows:inputCandidates', (event, category: unknown) => {
    if (!validSender(event)) throw new Error('IPC sender denied');
    return service.candidates(z.enum(['SOURCE', 'DATA', 'CODE']).parse(category));
  });
  ipcMain.handle('workflows:importInput', async (event, category: unknown) => {
    if (!validSender(event)) throw new Error('IPC sender denied');
    const purpose = z.enum(['DATA', 'CODE']).parse(category);
    const result = await dialog.showOpenDialog(window, {
      title: purpose === 'DATA' ? '导入科研数据' : '导入科研代码',
      properties: ['openFile', 'dontAddToRecent'],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    try {
      return await service.importFile(purpose, result.filePaths[0]!, async () => {
        const answer = await dialog.showMessageBox(window, {
          type: 'question',
          title: '导入科研资料',
          message: '允许读取所选 Workspace 文件并登记为科研输入？',
          detail: '最多 64 KiB UTF-8。仅登记内容与身份，后续模型或工具读取文件仍需原有权限。',
          buttons: ['取消', '读取并导入'],
          defaultId: 0,
          cancelId: 0,
        });
        return answer.response === 1;
      });
    } catch {
      throw new Error(
        '无法导入：请确认文件位于当前 Workspace、未越界、权限允许且不超过 64 KiB UTF-8',
      );
    }
  });
}
