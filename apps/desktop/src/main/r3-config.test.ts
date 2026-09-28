import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@cultivation/application';
import { R3DecisionConfigController, type R3DecisionProviderConfig } from './r3-config.js';

function fixture(envKey?: string) {
  let row: R3DecisionProviderConfig = {
    enabled: false,
    mode: 'SHADOW',
    apiKeyCiphertext: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const calls: string[] = [];
  const secrets: SecretStore = {
    encrypt: async (plaintext) => {
      calls.push(`encrypt:${plaintext.length}`);
      return new TextEncoder().encode(`sealed:${plaintext}`);
    },
    decrypt: async (ciphertext) => {
      calls.push('decrypt');
      return new TextDecoder().decode(ciphertext).replace(/^sealed:/, '');
    },
  };
  const controller = new R3DecisionConfigController(
    {
      getDecisionProviderConfig: () => row,
      saveDecisionProviderConfig: (next) => {
        row = next;
      },
    },
    secrets,
    async (key) => {
      calls.push(`test:${key.length}`);
      return { ok: true, model: 'jev-1.13.0' };
    },
    () => envKey,
  );
  return { controller, calls, stored: () => row };
}

describe('R3 Main decision credential boundary', () => {
  it('encrypts before persistence and never returns key or ciphertext in IPC view', async () => {
    const { controller, calls, stored } = fixture();
    const view = await controller.saveKey('secret-r3-key');
    expect(calls).toEqual(['encrypt:13']);
    expect(stored().apiKeyCiphertext).toBeInstanceOf(Uint8Array);
    expect(JSON.stringify(view)).not.toContain('secret-r3-key');
    expect(JSON.stringify(view)).not.toContain('sealed');
    expect(view.keySource).toBe('SAFE_STORAGE');
    expect(controller.setEnabled(true).enabled).toBe(true);
    expect(await controller.testConnection()).toEqual({
      ok: true,
      model: 'jev-1.13.0',
      message: '连接成功',
    });
    expect(calls).toEqual(['encrypt:13', 'decrypt', 'test:13']);
  });

  it('runs without a key and accepts an explicitly provided environment key', async () => {
    const empty = fixture();
    expect(empty.controller.getConfigView().configured).toBe(false);
    expect(() => empty.controller.setEnabled(true)).toThrow();
    expect((await empty.controller.testConnection()).ok).toBe(false);
    const withEnvironment = fixture('manual-key');
    expect(withEnvironment.controller.getConfigView().keySource).toBe('ENVIRONMENT');
    expect(withEnvironment.controller.setEnabled(true).mode).toBe('SHADOW');
    expect((await withEnvironment.controller.testConnection()).ok).toBe(true);
    expect(withEnvironment.stored().apiKeyCiphertext).toBeNull();
  });
});
