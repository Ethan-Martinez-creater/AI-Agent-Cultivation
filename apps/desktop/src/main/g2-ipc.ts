import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
import type { GenerationChatService } from './g2-chat.js';
import type { GenerationMediaStore } from './g2-media-store.js';
const id = z.string().min(1).max(128);
const reference = z.object({ teammateId: id, conversationId: id }).strict();
export const generationChatSendInput = reference
  .extend({
    prompt: z.string().min(1).max(12000),
    inputs: z.array(z.object({ artifactId: id, role: z.string().min(1).max(80) }).strict()).max(16),
    parameters: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 8000),
  })
  .strict();
export function registerGenerationChatIpc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  chat: GenerationChatService,
  media: GenerationMediaStore,
  artifactUrl: (id: string) => Promise<string>,
  listAttachments: () => ReturnType<GenerationMediaStore['list']> = () => media.list(),
) {
  const register = (channel: string, schema: z.ZodType, handler: (value: unknown) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new DomainError('IPC_DENIED', 'IPC sender denied');
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new DomainError('INVALID_INPUT', '生成对话参数无效');
      try {
        return await handler(Array.isArray(parsed.data) ? parsed.data[0] : parsed.data);
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'GENERATION_FAILED';
        throw new Error(`${code}: 生成操作未能安全完成`);
      }
    });
  };
  register('generationChat:listConversations', z.tuple([id]), (v) =>
    chat.listConversations(v as string),
  );
  register(
    'generationChat:createConversation',
    z.tuple([z.object({ teammateId: id, title: z.string().max(120).optional() }).strict()]),
    (v) => chat.createConversation(v as { teammateId: string; title?: string }),
  );
  register('generationChat:detail', z.tuple([reference]), (v) => chat.detail(reference.parse(v)));
  register('generationChat:refresh', z.tuple([reference]), (v) => chat.refresh(reference.parse(v)));
  register('generationChat:send', z.tuple([generationChatSendInput]), (v) =>
    chat.send(generationChatSendInput.parse(v)),
  );
  register('generationChat:descriptor', z.tuple([id]), (v) => chat.descriptor(v as string));
  register('generationChat:listAttachments', z.tuple([]), () => listAttachments());
  register('generationChat:importAttachment', z.tuple([]), async () => {
    const chosen = await dialog.showOpenDialog(window, {
      title: '导入生成参考素材',
      properties: ['openFile'],
      filters: [{ name: '媒体素材', extensions: ['png', 'mp4', 'wav'] }],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return null;
    return media.importSelectedFile(chosen.filePaths[0]!);
  });
  register('generationChat:artifactUrl', z.tuple([id]), (v) => artifactUrl(v as string));
}
