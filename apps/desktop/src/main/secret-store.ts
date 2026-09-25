import type { SecretStore } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';

/** The Electron safeStorage API is injected so it can be tested without Electron or OS keys. */
export interface SafeStorageBackend {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plaintext: string): Promise<Buffer>;
  decryptStringAsync(ciphertext: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly backend: SafeStorageBackend) {}

  private async ensureAvailable(): Promise<void> {
    if (!(await this.backend.isAsyncEncryptionAvailable())) {
      throw new DomainError('SECRET_STORE_UNAVAILABLE', '系统加密服务暂不可用');
    }
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    await this.ensureAvailable();
    return this.backend.encryptStringAsync(plaintext);
  }

  async decrypt(ciphertext: Uint8Array): Promise<string> {
    await this.ensureAvailable();
    const decrypted = await this.backend.decryptStringAsync(Buffer.from(ciphertext));
    return decrypted.result;
  }
}
