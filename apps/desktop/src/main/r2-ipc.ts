import { clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';
import type { HumanBridgeService, ExternalWorkService } from '@cultivation/application/r2-human-bridge-service';
import type { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import { FileWorkspace } from './file-workspace.js';
import type { Gate4ToolsService } from './gate4-tools-service.js';

const id = z.string().min(1).max(128);
const dimension = z.enum([
  'GENERAL_REASONING', 'LONG_CONTEXT_REASONING', 'AGENTIC_EXECUTION', 'CODING', 'TOOL_USE',
  'VISUAL_UNDERSTANDING', 'IMAGE_GENERATION', 'IMAGE_EDITING', 'VIDEO_GENERATION', 'VIDEO_EDITING',
  'SPEECH_UNDERSTANDING', 'SPEECH_GENERATION', 'SPEECH_TO_SPEECH', 'MUSIC_GENERATION',
]);
const display = z.object({
  name: z.string().min(1).max(120), avatar: z.string().max(2048).nullable(),
  title: z.string().max(160).nullable(), description: z.string().max(4000),
}).strict();
const appInput = z.object({
  id: id.optional(), name: z.string().min(1).max(256), vendor: z.string().max(256).nullable(),
  capabilities: z.array(dimension).min(1).max(14), notes: z.string().max(4000).nullable(),
  enabled: z.boolean(),
}).strict();
const submission = z.object({
  requestId: id,
  artifacts: z.array(z.object({targetArtifactId:id,relativePath:z.string().min(1).max(512)}).strict()).min(1).max(12),
}).strict();

/** Renderer only receives typed, validated operations; it never writes ExternalWork tables. */
export function registerR2Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  bridge: HumanBridgeService,
  work: ExternalWorkService,
  party: Gate5CollaborationService,
  tools: Gate4ToolsService,
): void {
  const register = (channel: string, handler: (args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      return handler(args);
    });
  };
  const none = (args: unknown[]): void => { if (args.length !== 0) throw new Error('请求参数无效'); };
  const one = <T>(args: unknown[], schema: z.ZodType<T>): T => {
    if (args.length !== 1) throw new Error('请求参数无效');
    return schema.parse(args[0]);
  };
  register('r2:bridgeProfile', (args) => { none(args); return bridge.capabilityProfile(); });
  register('r2:updateDisplay', (args) => bridge.updateDisplay(one(args, display)));
  register('r2:setCapability', (args) => bridge.setCapability(one(args, z.object({dimension,enabled:z.boolean()}).strict())));
  register('r2:listApps', (args) => { none(args); return bridge.listExternalAppProfiles(); });
  register('r2:saveApp', (args) => bridge.saveExternalAppProfile(one(args, appInput)));
  register('r2:listRequests', (args) => { none(args); return work.listExternalWorkRequests(); });
  register('r2:getRequest', (args) => work.getExternalWorkRequest(one(args, id)));
  register('r2:markInProgress', (args) => work.markInProgress(one(args, id)));
  register('r2:submitArtifacts', (args) => work.submitArtifacts(one(args, submission)));
  register('r2:accept', async (args) => {
    const input = one(args, z.object({requestId:id,publicResult:z.string().max(4000).optional()}).strict());
    const continuation = work.accept(input);
    await party.resumeExternalWork(continuation);
    return continuation;
  });
  register('r2:reject', (args) => work.reject(one(args, z.object({requestId:id,reason:z.string().max(500).optional()}).strict())));
  register('r2:cancel', async (args) => {
    const continuation = work.cancel(one(args, z.object({requestId:id}).strict()));
    await party.resumeExternalWork(continuation);
    return continuation;
  });
  register('r2:submitRating', (args) => bridge.submitRating(one(args, z.object({externalWorkRequestId:id,stars:z.number().int().min(1).max(5).optional(),skip:z.boolean().optional()}).strict())));
  register('r2:copyPrompt', (args) => {
    const detail = work.getExternalWorkRequest(one(args, id));
    if (!detail) throw new Error('ExternalWork 不存在');
    clipboard.writeText(detail.request.prompt);
  });
  register('r2:openTargetFolder', async (args) => {
    const detail = work.getExternalWorkRequest(one(args, id));
    if (!detail) throw new Error('ExternalWork 不存在');
    const root = tools.getWorkspace().rootPath;
    if (!root) throw new Error('请先选择 Workspace Root');
    const workspace = await FileWorkspace.open(root);
    const target = detail.request.targetWorkspacePathsJson.items[0] ?? '.';
    await workspace.list(target);
    const failed = await shell.openPath(join(workspace.getRoot(), target));
    if (failed) throw new Error('无法打开 Workspace 目录');
  });
}
