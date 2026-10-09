import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  parseWorkflowDraftContent,
  type WorkflowDraft,
  type WorkflowDraftContent,
  type WorkflowVersion,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';

/** Editing intent only: identity, source and published version are assigned by Main. */
export interface WorkflowEditorPort {
  listDrafts(): WorkflowDraft[];
  getDraft(id: string): WorkflowDraft;
  createDraft(input?: { name?: string }): WorkflowDraft;
  saveDraft(input: {
    id: string;
    expectedRevision: number;
    content: WorkflowDraftContent;
  }): WorkflowDraft;
  reorderDraft(input: { id: string; expectedRevision: number; stepIds: string[] }): WorkflowDraft;
  editVersion(input: { definitionId: string; version: number }): WorkflowDraft;
  copyVersion(input: { definitionId: string; version: number; name?: string }): WorkflowDraft;
  publishDraft(input: { id: string; expectedRevision: number }): WorkflowVersion;
}

const identity = z.string().min(1).max(128);
const revision = z.number().int().min(1).max(1_000_000);
const frozenIdentity = z
  .object({ definitionId: identity, version: z.number().int().min(1).max(10_000) })
  .strict();

function editorDiagnostic(message: string): string {
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  if (/dominat|upstream|producer output must|required producer/i.test(message))
    return '输入产物必须由此前步骤在每条必需路径上产生，且必需输入不能引用可选输出';
  if (/cycle|self-referential|dangling|unreachable/i.test(message))
    return '步骤连接无效：请检查循环、未连接的步骤或不存在的目标';
  if (/reorder|sequential|order/i.test(message))
    return '当前排序会改变条件分支或输入依赖，请先调整连接';
  if (/REVIEW_PASS|REVIEW|verdict/i.test(message))
    return '审核步骤需要真实输入、结构化审核结果和兼容的结论分支';
  if (/DECISION|condition|branch|route/i.test(message))
    return '条件分支必须读取已声明的 JSON 输入，且不能重复或产生歧义';
  if (/title|objective|name|category/i.test(message))
    return '请填写工作流名称、分类和每个步骤的名称与目标';
  if (/routing|capability|constraint/i.test(message)) return '请检查步骤的能力需求和执行方式';
  if (/final output|projection/i.test(message)) return '最终结果必须引用步骤已声明的兼容输出';
  if (/schema|Artifact|contract|validator/i.test(message))
    return '输入或输出约定无效，请检查字段、类型与大小限制';
  if (/unique|duplicate/i.test(message)) return '步骤、输出和分支编号不能重复';
  return '工作流草稿无效，请检查步骤、连接和输入输出约定';
}

export function registerWorkflowEditorIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: WorkflowEditorPort,
): void {
  const register = <T>(name: string, schema: z.ZodType<T>, handle: (input: T) => unknown) => {
    const channel = `workflowEditor:${name}`;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      let input: T;
      try {
        input = schema.parse(args);
      } catch {
        throw new Error('工作流编辑请求无效');
      }
      try {
        return handle(input);
      } catch (error) {
        if (error instanceof DomainError) {
          // Validators emit static bounded diagnostics, never objectives, credentials or raw versions.
          throw new Error(
            error.code === 'INVALID_INPUT' && error.message.length <= 300
              ? editorDiagnostic(error.message)
              : error.code === 'CONFLICT'
                ? '草稿已变更，请重新打开后再保存或发布'
                : error.code === 'NOT_FOUND'
                  ? '工作流草稿或版本不存在'
                  : '工作流编辑操作被拒绝，请检查草稿和版本',
          );
        }
        throw new Error('工作流保存失败，已保留原版本');
      }
    });
  };
  register('listDrafts', z.tuple([]), () => service.listDrafts());
  register('getDraft', z.tuple([identity]), ([id]) => service.getDraft(id));
  register(
    'createDraft',
    z.tuple([z.object({ name: z.string().min(1).max(256).optional() }).strict()]),
    ([input]) => service.createDraft(input),
  );
  register(
    'saveDraft',
    z.tuple([
      z.object({ id: identity, expectedRevision: revision, content: z.unknown() }).strict(),
    ]),
    ([input]) => service.saveDraft({ ...input, content: parseWorkflowDraftContent(input.content) }),
  );
  register(
    'reorderDraft',
    z.tuple([
      z
        .object({
          id: identity,
          expectedRevision: revision,
          stepIds: z.array(identity).min(1).max(32),
        })
        .strict(),
    ]),
    ([input]) => service.reorderDraft(input),
  );
  register('editVersion', z.tuple([frozenIdentity]), ([input]) => service.editVersion(input));
  register(
    'copyVersion',
    z.tuple([frozenIdentity.extend({ name: z.string().min(1).max(256).optional() }).strict()]),
    ([input]) => service.copyVersion(input),
  );
  register(
    'publishDraft',
    z.tuple([z.object({ id: identity, expectedRevision: revision }).strict()]),
    ([input]) => service.publishDraft(input),
  );
}
