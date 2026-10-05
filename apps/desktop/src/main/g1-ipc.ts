import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import type { GenerationService } from '@cultivation/application/g1-generation';
const id = z.string().min(1).max(128);
export const generationCreateInput = z
  .object({
    teammateId: id,
    capability: z.enum([
      'IMAGE_GENERATION',
      'IMAGE_EDITING',
      'VIDEO_GENERATION',
      'SPEECH_GENERATION',
      'MUSIC_GENERATION',
    ]),
    requiredFeatures: z.array(z.string().min(1).max(80)).max(24),
    prompt: z.string().min(1).max(12000),
    inputs: z.array(z.object({ artifactId: id, role: z.string().min(1).max(80) }).strict()).max(16),
    parameters: z.record(z.string(), z.unknown()).refine((v) => {
      try {
        return JSON.stringify(v).length <= 8000;
      } catch {
        return false;
      }
    }),
    expectedOutput: z
      .object({
        artifactKind: z.enum(['IMAGE', 'VIDEO', 'AUDIO']),
        mimeTypes: z.array(z.string().min(1).max(80)).min(1).max(6),
      })
      .strict(),
  })
  .strict();
export function registerGenerationIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: GenerationService,
): void {
  const register = (
    channel: string,
    schema: z.ZodType,
    handler: (...args: unknown[]) => unknown,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new DomainError('IPC_DENIED', 'IPC sender denied');
      const result = schema.safeParse(args);
      if (!result.success) throw new DomainError('INVALID_INPUT', '生成请求参数无效');
      try {
        return await handler(...args);
      } catch (error) {
        throw error instanceof DomainError
          ? error
          : new DomainError('GENERATION_FAILED', '生成操作未能安全完成');
      }
    });
  };
  register('generation:list', z.tuple([]), () => service.list());
  register('generation:detail', z.tuple([id]), (value) => service.detail(value as string));
  register('generation:advance', z.tuple([id]), (value) => service.advance(value as string));
  register('generation:create', z.tuple([generationCreateInput]), (value) => {
    const input = generationCreateInput.parse(value);
    const { teammateId, ...taskInput } = input;
    return service.create({
      ...taskInput,
      targetTeammateId: teammateId,
      outputDestination: { scope: 'APP_ARTIFACT_STORE' },
      requester: { actorType: 'USER', actorId: 'local-user' },
      missionId: null,
      runId: null,
      workflowRunId: null,
      workflowStepRunId: null,
    });
  });
}
