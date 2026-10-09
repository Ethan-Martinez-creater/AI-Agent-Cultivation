import { ipcMain, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { toWorkflowImportProposalSafeDto, type WorkflowInputs } from '@cultivation/domain';
import type { WorkflowImportService } from '@cultivation/application';
import type { WorkflowImportSources } from './w3-2-import-sources.js';
import { DomainError } from '@cultivation/shared';

const id = z.string().min(1).max(256);
const revision = z.number().int().min(1).max(1_000_000);
const edit = z.object({ proposalId: id, revision }).strict();

export function registerWorkflowImportIpc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: WorkflowImportService,
  sources: WorkflowImportSources,
): void {
  const register = <T>(name: string, schema: z.ZodType<T>, handle: (input: T) => unknown) => {
    const channel = `workflowImports:${name}`;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handle(schema.parse(args));
      } catch (error) {
        if (error instanceof DomainError && /[\u4e00-\u9fff]/.test(error.message))
          throw new Error(error.message.slice(0, 350));
        throw new Error('导入请求无效，未更改正式运行；请检查来源、映射和冻结版本');
      }
    });
  };
  register(
    'prepare',
    z.tuple([
      z
        .object({
          definitionId: id,
          version: z.number().int().min(1).max(10000),
          inputs: z.record(z.string(), z.unknown()).optional(),
          description: z.string().max(2000).optional(),
        })
        .strict(),
    ]),
    ([input]) =>
      toWorkflowImportProposalSafeDto(
        service.prepare({ ...input, inputs: input.inputs as WorkflowInputs | undefined }),
      ),
  );
  register('get', z.tuple([id]), ([proposalId]) =>
    toWorkflowImportProposalSafeDto(service.get(proposalId)),
  );
  register('list', z.tuple([]), () => service.list().map(toWorkflowImportProposalSafeDto));
  register('selectSource', z.tuple([id]), async ([proposalId]) => {
    const current = service.get(proposalId);
    if (['CANCELLED', 'COMMITTED'].includes(current.status))
      throw new DomainError('CONFLICT', '导入已取消或提交');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择已有工作成果',
      properties: ['openFile', 'dontAddToRecent'],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    const source = await sources.readSelected(selected.filePaths[0]!, async () => {
      const consent = await dialog.showMessageBox(window, {
        title: '读取已有成果',
        type: 'question',
        message: '读取所选工作目录文件，并保存导入快照？',
        detail: '支持最多 64 KiB 的 UTF-8 文本或 JSON。不会授予道友或工具额外权限。',
        buttons: ['取消', '读取快照'],
        defaultId: 0,
        cancelId: 0,
      });
      return consent.response === 1;
    });
    return source ? toWorkflowImportProposalSafeDto(service.addSource(proposalId, source)) : null;
  });
  register(
    'revise',
    z.tuple([
      edit
        .extend({
          completedStepIds: z.array(id).max(32),
          currentStepId: id,
          bindings: z
            .array(z.object({ stepId: id, outputKey: id, sourceId: id }).strict())
            .max(128),
        })
        .strict(),
    ]),
    ([input]) => toWorkflowImportProposalSafeDto(service.revise(input)),
  );
  register('confirm', z.tuple([edit]), ([input]) => service.confirm(input));
  register('cancel', z.tuple([edit]), ([input]) =>
    toWorkflowImportProposalSafeDto(service.cancel(input)),
  );
}
