import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { CAPABILITY_DIMENSIONS } from '@cultivation/application';
import type { RoutingMissionService } from '@cultivation/application';
import type { R4RoutingRepository } from '@cultivation/persistence';
import type { R3DecisionConfigController } from './r3-config.js';
import { DomainError } from '@cultivation/shared';
import type { Mission } from '@cultivation/domain';

const id = z.string().min(1).max(128);
const metadataText = z.string().max(160);
const routingContext = z
  .object({
    objective: z.string().trim().min(1).max(8000),
    requiredCapabilities: z.array(z.enum(CAPABILITY_DIMENSIONS)).max(14).optional(),
    executionConstraint: z.enum(['AUTO', 'SOLO', 'PARTY', 'HUMAN_BRIDGE']).optional(),
    explicitTeammateId: id.optional(),
    explicitPartyId: id.optional(),
    partyMode: z.enum(['CONSULTATION', 'REVIEW', 'DELEGATION']).optional(),
    inputArtifactMetadata: z
      .array(
        z
          .object({ id, name: metadataText, kind: metadataText, mimeType: metadataText.optional() })
          .strict(),
      )
      .max(12)
      .optional(),
    expectedOutputContract: z
      .object({
        name: z
          .string()
          .regex(/^[^\\/:]{1,128}$/)
          .refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32)),
        allowedExtensions: z
          .array(z.string().regex(/^\.[a-z0-9]{1,12}$/))
          .min(1)
          .max(16),
        maxSizeBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024),
      })
      .strict()
      .optional(),
    executionContext: z
      .object({
        origin: metadataText,
        executionId: id.optional(),
        stepId: id.optional(),
        stepType: metadataText.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function registerRoutingIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: RoutingMissionService,
  repository: R4RoutingRepository,
  credentials: R3DecisionConfigController,
  onCreated?: (mission: Mission) => void | Promise<void>,
): void {
  const register = (channel: string, handler: (args: unknown[]) => unknown | Promise<unknown>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handler(args);
      } catch (error) {
        throw new Error(
          error instanceof DomainError ? error.message : '智能分配失败，请检查配置后重试',
        );
      }
    });
  };
  register('routing:config', (args) => {
    z.tuple([]).parse(args);
    return repository.config();
  });
  register('routing:setCloudEnabled', (args) => {
    const [enabled] = z.tuple([z.boolean()]).parse(args);
    if (enabled && !credentials.getConfigView().configured)
      throw new DomainError('INVALID_INPUT', '请先配置 Jev API Key');
    return repository.setCloudEnabled(enabled);
  });
  register('routing:createMission', async (args) => {
    const [input] = z
      .tuple([
        z.object({ title: z.string().trim().min(1).max(120), context: routingContext }).strict(),
      ])
      .parse(args);
    const result = await service.createMission(input);
    if (result.status === 'CREATED' && onCreated)
      void Promise.resolve(onCreated(result.mission)).catch(() => undefined);
    return result;
  });
  register('routing:receipts', (args) => {
    const [missionId] = z.tuple([id.optional()]).parse(args);
    return repository.listReceipts(missionId);
  });
}
