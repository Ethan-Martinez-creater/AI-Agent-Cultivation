import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => mocks.handlers.delete(name),
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, fn),
  },
}));
import { registerGenerationIpc } from './g1-ipc.js';
import type { GenerationService } from '@cultivation/application/g1-generation';
describe('G1 typed Main boundary', () => {
  it('rejects filesystem destinations, self-reported paths/state and invalid sender', async () => {
    const sender = {} as never;
    const create = vi.fn(async (input) => input);
    registerGenerationIpc((e) => e === sender, {
      create,
      list: () => [],
      detail: () => ({}),
      advance: () => ({}),
    } as unknown as GenerationService);
    const input = {
      teammateId: 't',
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: '图片',
      inputs: [],
      parameters: {},
      expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    };
    await expect(mocks.handlers.get('generation:create')!({}, input)).rejects.toMatchObject({
      code: 'IPC_DENIED',
    });
    for (const change of [
      { outputDestination: { scope: 'MISSION_WORKSPACE', path: 'C:\\secret' } },
      { state: 'COMPLETED' },
      { inputs: [{ artifactId: 'id', role: 'REFERENCE', path: 'C:\\secret' }] },
    ])
      await expect(
        mocks.handlers.get('generation:create')!(sender, { ...input, ...change }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(create).not.toHaveBeenCalled();
    const result = await mocks.handlers.get('generation:create')!(sender, input);
    expect(result).toMatchObject({
      outputDestination: { scope: 'APP_ARTIFACT_STORE' },
      missionId: null,
      requester: { actorType: 'USER' },
    });
    expect(mocks.handlers.has('generation:writeFile')).toBe(false);
  });
});
