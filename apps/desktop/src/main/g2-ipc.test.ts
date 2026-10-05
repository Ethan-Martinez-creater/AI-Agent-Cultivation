import { describe, it, expect, vi } from 'vitest';
import type { GenerationChatService } from './g2-chat.js';
import type { GenerationMediaStore } from './g2-media-store.js';
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  picker: vi.fn(),
}));
vi.mock('electron', () => ({
  dialog: { showOpenDialog: mock.picker },
  ipcMain: {
    removeHandler: (c: string) => mock.handlers.delete(c),
    handle: (c: string, f: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mock.handlers.set(c, f),
  },
}));
import { registerGenerationChatIpc } from './g2-ipc.js';
describe('G2 typed IPC boundary', () => {
  it('rejects paths, provider URLs, keys, forged actor/state and invalid sender', async () => {
    const sender = {} as never;
    const send = vi.fn();
    const importSelectedFile = vi.fn();
    registerGenerationChatIpc(
      {} as never,
      (e) => e === sender,
      { send } as unknown as GenerationChatService,
      { importSelectedFile, list: () => [] } as unknown as GenerationMediaStore,
      async () => 'cultivation-media://artifact/token',
    );
    const valid = {
      teammateId: 't',
      conversationId: 'c',
      prompt: '生成视频',
      inputs: [],
      parameters: { duration: 5 },
    };
    await expect(mock.handlers.get('generationChat:send')!({}, valid)).rejects.toMatchObject({
      code: 'IPC_DENIED',
    });
    for (const extra of [
      { outputDestination: { path: 'C:\\secret' } },
      { apiKey: 'key' },
      { actorId: 'other' },
      { providerUrl: 'https://other' },
      { state: 'COMPLETED' },
      { inputs: [{ artifactId: 'id', role: 'FIRST_FRAME', path: 'C:\\secret' }] },
    ])
      await expect(
        mock.handlers.get('generationChat:send')!(sender, { ...valid, ...extra }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(send).not.toHaveBeenCalled();
    await expect(
      mock.handlers.get('generationChat:importAttachment')!(sender, 'C:\\secret'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(importSelectedFile).not.toHaveBeenCalled();
  });
  it('imports only an explicit native picker result and returns bounded metadata', async () => {
    const sender = {} as never;
    mock.picker.mockResolvedValue({ canceled: false, filePaths: ['selected-by-main.png'] });
    const importSelectedFile = vi.fn(async () => ({
      id: 'a',
      kind: 'IMAGE',
      mimeType: 'image/png',
      contentHash: '0'.repeat(64),
      sizeBytes: 12,
      name: 'frame.png',
    }));
    registerGenerationChatIpc(
      {} as never,
      (e) => e === sender,
      {} as GenerationChatService,
      { importSelectedFile, list: () => [] } as unknown as GenerationMediaStore,
      async () => 'cultivation-media://artifact/token',
    );
    const result = await mock.handlers.get('generationChat:importAttachment')!(sender);
    expect(importSelectedFile).toHaveBeenCalledWith('selected-by-main.png');
    expect(JSON.stringify(result)).not.toContain('selected-by-main');
  });
});
