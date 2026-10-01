import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { WorkflowDetail, WorkflowRun, WorkflowVersion } from '@cultivation/domain';

const workflowId = z.string().trim().min(1).max(128);
const versionNumber = z.number().int().min(1).max(10_000);

/** Structural boundary so Main can compose the concrete application service. */
export interface WorkflowServicePort {
  listVersions(): WorkflowVersion[];
  listRuns(): WorkflowRun[];
  detail(runId: string): WorkflowDetail;
  createRun(input: { definitionId: string; version: number }): WorkflowDetail;
  advance(runId: string): Promise<WorkflowDetail>;
  retryMission(runId: string): Promise<WorkflowDetail>;
  retryStep(runId: string): WorkflowDetail;
  pause(runId: string): WorkflowDetail;
  resume(runId: string): Promise<WorkflowDetail>;
  cancel(runId: string): WorkflowDetail;
}

export function registerWorkflowIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: WorkflowServicePort,
): void {
  const register = (
    channel: string,
    parse: (args: unknown[]) => unknown,
    handle: (value: unknown) => unknown | Promise<unknown>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      let value: unknown;
      try {
        value = parse(args);
      } catch {
        throw new Error('请求参数无效');
      }
      try {
        return await handle(value);
      } catch {
        throw new Error('工作流操作失败，请检查运行状态后重试');
      }
    });
  };
  const noArgs = (args: unknown[]) => z.tuple([]).parse(args);
  const withId = (args: unknown[]) => z.tuple([workflowId]).parse(args)[0];

  register('workflows:versions', noArgs, () => service.listVersions());
  register('workflows:list', noArgs, () => service.listRuns());
  register(
    'workflows:detail',
    (args) => withId(args),
    (id) => service.detail(id as string),
  );
  register(
    'workflows:create',
    (args) =>
      z
        .tuple([z.object({ definitionId: workflowId, version: versionNumber }).strict()])
        .parse(args)[0],
    (input) => service.createRun(input as { definitionId: string; version: number }),
  );
  register(
    'workflows:advance',
    (args) => withId(args),
    (id) => service.advance(id as string),
  );
  register(
    'workflows:retryMission',
    (args) => withId(args),
    (id) => service.retryMission(id as string),
  );
  register(
    'workflows:retryStep',
    (args) => withId(args),
    (id) => service.retryStep(id as string),
  );
  register(
    'workflows:pause',
    (args) => withId(args),
    (id) => service.pause(id as string),
  );
  register(
    'workflows:resume',
    (args) => withId(args),
    (id) => service.resume(id as string),
  );
  register(
    'workflows:cancel',
    (args) => withId(args),
    (id) => service.cancel(id as string),
  );
}
