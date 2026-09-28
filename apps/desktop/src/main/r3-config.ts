import type { SecretStore } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';
import type { R3DecisionConfigView } from '../preload/preload.js';

export interface R3DecisionProviderConfig {
  enabled: boolean;
  mode: 'SHADOW';
  apiKeyCiphertext: Uint8Array | null;
  updatedAt: string;
}

export interface R3DecisionConfigStore {
  getDecisionProviderConfig(): R3DecisionProviderConfig;
  saveDecisionProviderConfig(value: R3DecisionProviderConfig): void;
}

export interface R3TestConnectionResult {
  ok: boolean;
  model: string | null;
  message: string;
}

/** Main-only credential boundary. No method returns plaintext or ciphertext to Renderer. */
export class R3DecisionConfigController {
  constructor(
    private readonly store: R3DecisionConfigStore,
    private readonly secrets: SecretStore,
    private readonly testGateway: (apiKey: string) => Promise<{ ok: boolean; model: string }>,
    private readonly envKey: () => string | undefined = () => process.env.TYPESAFE_API_KEY,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getConfigView(): R3DecisionConfigView {
    const config = this.store.getDecisionProviderConfig();
    const keySource = config.apiKeyCiphertext
      ? 'SAFE_STORAGE'
      : this.envKey()?.trim()
        ? 'ENVIRONMENT'
        : 'NONE';
    return {
      provider: 'TYPESAFE',
      model: 'jev-1.13.0',
      mode: 'SHADOW',
      enabled: config.enabled,
      configured: keySource !== 'NONE',
      keySource,
    };
  }

  async saveKey(plaintext: string): Promise<R3DecisionConfigView> {
    const key = plaintext.trim();
    if (key.length < 1 || key.length > 16_384) {
      throw new DomainError('INVALID_INPUT', '请先复制有效的 TypeSafe API Key');
    }
    const ciphertext = await this.secrets.encrypt(key);
    const config = this.store.getDecisionProviderConfig();
    this.store.saveDecisionProviderConfig({
      ...config,
      apiKeyCiphertext: ciphertext,
      updatedAt: this.now(),
    });
    return this.getConfigView();
  }

  setEnabled(enabled: boolean): R3DecisionConfigView {
    if (enabled && !this.getConfigView().configured) {
      throw new DomainError('INVALID_INPUT', '请先配置 TypeSafe API Key');
    }
    const config = this.store.getDecisionProviderConfig();
    this.store.saveDecisionProviderConfig({ ...config, enabled, updatedAt: this.now() });
    return this.getConfigView();
  }

  async resolveKey(): Promise<string | null> {
    const config = this.store.getDecisionProviderConfig();
    if (config.apiKeyCiphertext) return this.secrets.decrypt(config.apiKeyCiphertext);
    return this.envKey()?.trim() || null;
  }

  async testConnection(): Promise<R3TestConnectionResult> {
    try {
      const key = await this.resolveKey();
      if (!key) return { ok: false, model: null, message: '未配置 TypeSafe API Key' };
      const result = await this.testGateway(key);
      return result.ok
        ? { ok: true, model: result.model, message: '连接成功' }
        : { ok: false, model: null, message: 'TypeSafe 连接失败或模型不可用' };
    } catch {
      return { ok: false, model: null, message: 'TypeSafe 连接失败或模型不可用' };
    }
  }
}
