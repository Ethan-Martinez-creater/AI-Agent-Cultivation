import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@cultivation/application/r0-decision';
import { resolveToolShortlistCloudGateway } from './r5-4-cloud-gateway.js';

describe('Tool shortlist Cloud opt-in at dispatch', () => {
  it('does not read a key or create a gateway while disabled', async () => {
    const resolveKey = vi.fn();
    const create = vi.fn();
    expect(
      await resolveToolShortlistCloudGateway({ enabled: () => false, resolveKey, create }),
    ).toBeNull();
    expect(resolveKey).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not create a gateway when disabled during the SecretStore await', async () => {
    let enabled = true;
    let finish!: (key: string) => void;
    const key = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const create = vi.fn();
    const pending = resolveToolShortlistCloudGateway({
      enabled: () => enabled,
      resolveKey: () => key,
      create,
    });
    enabled = false;
    finish('test-only-key');
    expect(await pending).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('checks opt-in again when a previously resolved gateway is about to send metadata', async () => {
    let enabled = true;
    const evaluate = vi.fn();
    const gateway = await resolveToolShortlistCloudGateway({
      enabled: () => enabled,
      resolveKey: async () => 'test-only-key',
      create: () => ({ evaluate }),
    });
    enabled = false;
    await expect(gateway!.evaluate({} as DecisionRequest)).rejects.toThrow(
      'Cloud decision disabled',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});
