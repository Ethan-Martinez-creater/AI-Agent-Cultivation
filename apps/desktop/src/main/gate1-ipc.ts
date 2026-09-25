import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { DomainError } from '@cultivation/shared';
import type { ChatStreamEvent } from '../preload/preload.js';

const idSchema = z.string().min(1).max(128);
const providerInput = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENAI_COMPATIBLE']),
    baseUrl: z.string().max(2048).nullable().optional(),
  })
  .strict();
const credentialInput = z
  .object({
    providerId: idSchema,
    label: z.string().min(1).max(120),
  })
  .strict();
const runtimeInput = z
  .object({
    name: z.string().min(1).max(120),
    providerId: idSchema,
    credentialId: idSchema.nullable(),
    modelId: z.string().min(1).max(256),
  })
  .strict();
const teammateInput = z
  .object({
    name: z.string().min(1).max(120),
    avatar: z.string().max(2048).nullable(),
    title: z.string().max(120).nullable(),
    description: z.string().max(4096),
    identityPrompt: z.string().max(32_768),
    behaviorPrompt: z.string().max(32_768),
    currentRuntimeProfileId: idSchema,
  })
  .strict();
const chatReference = z.object({ teammateId: idSchema, conversationId: idSchema }).strict();
const chatSend = chatReference
  .extend({
    requestId: z.string().uuid(),
    text: z.string().min(1).max(32_768),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('INVALID_INPUT', '请求参数无效');
  return result.data;
}

function publicError(error: unknown): string {
  return error instanceof DomainError ? error.message : '操作失败，请检查配置后重试';
}

export function registerGate1Ipc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: Gate1Service,
): void {
  const activeRequests = new Set<string>();
  const register = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handler(event, args);
      } catch (error) {
        throw new Error(publicError(error));
      }
    });
  };
  const noArgs = (args: unknown[]): void => {
    if (args.length !== 0) throw new DomainError('INVALID_INPUT', '请求参数无效');
  };
  const one = <T>(args: unknown[], schema: z.ZodType<T>): T => {
    if (args.length !== 1) throw new DomainError('INVALID_INPUT', '请求参数无效');
    return parse(schema, args[0]);
  };

  register('providers:list', (_event, args) => {
    noArgs(args);
    return service.listProviders();
  });
  register('providers:create', (_event, args) => service.createProvider(one(args, providerInput)));
  register('credentials:list', (_event, args) => {
    if (args.length !== 1) throw new DomainError('INVALID_INPUT', '请求参数无效');
    const providerId = parse(idSchema.optional(), args[0]);
    return service.listCredentials(providerId);
  });
  register('credentials:create', async (_event, args) => {
    const input = one(args, credentialInput);
    const apiKey = (await clipboard.readText()).trim();
    clipboard.clear();
    if (!apiKey || apiKey.length > 16_384) {
      throw new DomainError('INVALID_INPUT', '请先复制有效的 API Key 到剪贴板');
    }
    return service.createCredential({ ...input, apiKey });
  });
  register('runtimes:list', (_event, args) => {
    noArgs(args);
    return service.listRuntimeProfiles();
  });
  register('runtimes:create', (_event, args) =>
    service.createRuntimeProfile(one(args, runtimeInput)),
  );
  register('runtimes:update', (_event, args) =>
    service.updateRuntimeProfile(one(args, runtimeInput.extend({ id: idSchema }))),
  );
  register('runtimes:testConnection', (_event, args) =>
    service.testConnection(one(args, idSchema)),
  );
  register('teammates:list', (_event, args) => {
    noArgs(args);
    return service.listTeammates();
  });
  register('teammates:create', (_event, args) => service.createTeammate(one(args, teammateInput)));
  register('teammates:update', (_event, args) =>
    service.updateTeammate(one(args, teammateInput.extend({ id: idSchema }))),
  );
  register('teammates:archive', (_event, args) => service.archiveTeammate(one(args, idSchema)));
  register('teammates:duplicate', (_event, args) => service.duplicateTeammate(one(args, idSchema)));
  register('teammates:switchRuntime', (_event, args) =>
    service.switchRuntime(
      one(args, z.object({ teammateId: idSchema, runtimeProfileId: idSchema }).strict()),
    ),
  );
  register('chat:listConversations', (_event, args) =>
    service.listConversations(one(args, idSchema)),
  );
  register('chat:createConversation', (_event, args) =>
    service.createConversation(one(args, idSchema)),
  );
  register('chat:listMessages', (_event, args) => {
    const input = one(args, chatReference);
    return service.listMessages(input.teammateId, input.conversationId);
  });
  register('usage:list', (_event, args) => {
    if (args.length !== 1) throw new DomainError('INVALID_INPUT', '请求参数无效');
    return service.listUsage(parse(idSchema.optional(), args[0]));
  });
  register('chat:send', (event, args) => {
    const input = one(args, chatSend);
    if (activeRequests.has(input.requestId)) throw new DomainError('CHAT_BUSY', '请求正在执行');
    activeRequests.add(input.requestId);
    const emit = (payload: ChatStreamEvent): void => {
      if (!window.isDestroyed() && !event.sender.isDestroyed())
        event.sender.send('chat:event', payload);
    };
    void (async () => {
      try {
        for await (const update of service.streamChat(input)) {
          if (update.type === 'delta') {
            emit({
              type: 'delta',
              requestId: input.requestId,
              teammateId: input.teammateId,
              conversationId: input.conversationId,
              text: update.text,
            });
          } else {
            emit({
              type: 'done',
              requestId: input.requestId,
              teammateId: input.teammateId,
              conversationId: input.conversationId,
              assistantMessage: update.assistantMessage,
            });
          }
        }
      } catch (error) {
        emit({
          type: 'error',
          requestId: input.requestId,
          teammateId: input.teammateId,
          conversationId: input.conversationId,
          message: publicError(error),
        });
      } finally {
        activeRequests.delete(input.requestId);
      }
    })();
    return { requestId: input.requestId, conversationId: input.conversationId };
  });
}
