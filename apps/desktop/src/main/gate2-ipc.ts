import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import { Gate2MemoryService } from '@cultivation/application/gate2-memory-service';
import { Gate2HybridMemoryService } from '@cultivation/application/gate2-hybrid-memory-service';
import { SkillService, SkillServiceError } from '@cultivation/application/skill-service';

const id = z.string().min(1).max(128);
const memoryType = z.enum([
  'IDENTITY',
  'PREFERENCE',
  'FACT',
  'EPISODE',
  'PROCEDURE',
  'OBSERVATION',
]);
const memoryStatus = z.enum(['PROPOSED', 'ACTIVE', 'REJECTED', 'ARCHIVED']);
const memoryEdit = z
  .object({
    memoryType,
    content: z.string().min(1).max(2_000),
    summary: z.string().max(240),
    importance: z.number().min(0).max(1),
  })
  .strict();
const skillInput = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1_000),
    instructions: z.string().min(1).max(24_000),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
const assignment = z.object({ teammateId: id, skillId: id }).strict();

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
  if (error instanceof SkillServiceError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return 'Skill 不存在';
      case 'ARCHIVED':
        return '已归档 Skill 不可修改或启用';
      case 'ASSIGNMENT_NOT_FOUND':
        return '道友尚未分配此 Skill';
      case 'CONFLICT':
        return 'Skill 版本冲突，请刷新后重试';
      default:
        return 'Skill 输入无效';
    }
  }
  return '操作失败，请检查配置后重试';
}

export function registerGate2Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  memories: Gate2MemoryService,
  skills: SkillService,
  hybrid: Gate2HybridMemoryService,
): void {
  const changed = <T extends ReturnType<Gate2MemoryService['createManual']>>(record: T): T => {
    void hybrid.onMemoryChanged(record).catch(() => undefined);
    return record;
  };
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

  register('memories:list', (args) => {
    const input = one(z.object({ teammateId: id, status: memoryStatus.optional() }).strict(), args);
    return memories.list(input.teammateId, input.status);
  });
  register('memories:create', (args) => {
    const input = one(memoryEdit.extend({ teammateId: id }), args);
    return changed(memories.createManual(input.teammateId, input));
  });
  register('memories:update', (args) => {
    const input = one(memoryEdit.extend({ teammateId: id, id }), args);
    return changed(memories.update(input.teammateId, input.id, input));
  });
  register('memories:archive', (args) => {
    const input = one(z.object({ teammateId: id, id }).strict(), args);
    return changed(memories.archive(input.teammateId, input.id));
  });
  register('memories:accept', (args) => {
    const input = one(
      z
        .object({
          teammateId: id,
          id,
          edits: memoryEdit.partial().strict().optional(),
        })
        .strict(),
      args,
    );
    return changed(memories.accept(input.teammateId, input.id, input.edits));
  });
  register('memories:reject', (args) => {
    const input = one(z.object({ teammateId: id, id }).strict(), args);
    return changed(memories.reject(input.teammateId, input.id));
  });
  register('memories:proposeFromMessage', (args) => {
    const input = one(
      z.object({ teammateId: id, conversationId: id, messageId: id }).strict(),
      args,
    );
    return memories.proposeFromMessage(input);
  });

  register('embedding:getConfig', (args) => {
    noArgs(args);
    return hybrid.getConfig();
  });
  register('embedding:setConfig', (args) => {
    const input = one(z.object({ runtimeProfileId: id.nullable() }).strict(), args);
    return hybrid.configure(input.runtimeProfileId);
  });
  register('embedding:reindex', (args) => {
    const input = one(z.object({ teammateId: id }).strict(), args);
    return hybrid.reindex(input.teammateId);
  });

  register('skills:list', (args) => {
    noArgs(args);
    return skills.list();
  });
  register('skills:create', (args) => skills.create(one(skillInput, args)));
  register('skills:update', (args) => skills.update(one(skillInput.extend({ id }), args)));
  register('skills:archive', (args) => skills.archive(one(id, args)));
  register('skills:listRevisions', (args) => skills.listRevisions(one(id, args)));
  register('skills:listAssignments', (args) => skills.listAssignments(one(id, args)));
  register('skills:assign', (args) => {
    const input = one(assignment, args);
    return skills.assign(input.teammateId, input.skillId);
  });
  register('skills:unassign', (args) => {
    const input = one(assignment, args);
    return skills.unassign(input.teammateId, input.skillId);
  });
  register('skills:setEnabled', (args) => {
    const input = one(assignment.extend({ enabled: z.boolean() }), args);
    return input.enabled
      ? skills.enable(input.teammateId, input.skillId)
      : skills.disable(input.teammateId, input.skillId);
  });
}
