import { describe, expect, it } from 'vitest';
import { ElectronSecretStore, type SafeStorageBackend } from './secret-store.js';

function fakeBackend(): SafeStorageBackend {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => Buffer.from(`encrypted:${text}`).reverse(),
    decryptStringAsync: async (bytes) => ({
      result: Buffer.from(bytes).reverse().toString('utf8').slice('encrypted:'.length),
      shouldReEncrypt: false,
    }),
  };
}

describe('Main SecretStore', () => {
  it('encrypts before storage and decrypts only in Main', async () => {
    const store = new ElectronSecretStore(fakeBackend());
    const ciphertext = await store.encrypt('sk-test-private');
    expect(Buffer.from(ciphertext).toString('utf8')).not.toContain('sk-test-private');
    expect(await store.decrypt(ciphertext)).toBe('sk-test-private');
  });

  it('fails closed when OS encryption is unavailable', async () => {
    const store = new ElectronSecretStore({
      ...fakeBackend(),
      isAsyncEncryptionAvailable: async () => false,
    });
    await expect(store.encrypt('sk-test-private')).rejects.toMatchObject({
      code: 'SECRET_STORE_UNAVAILABLE',
    });
  });
});
