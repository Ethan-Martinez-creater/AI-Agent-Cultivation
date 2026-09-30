import { describe, expect, it } from 'vitest';
import {
  canTestNewModel,
  newModelCredentialId,
  reusableRuntimeTemplates,
} from './create-model-policy.js';

describe('create teammate model selection', () => {
  it('exposes only the reusable template when multiple teammates bind the same model', () => {
    const runtimes = ['template', 'private-a', 'private-b'].map((id) => ({
      id,
      modelId: 'same-model',
    }));
    const teammates = [
      { currentRuntimeProfileId: 'private-a', status: 'ACTIVE' },
      { currentRuntimeProfileId: 'private-b', status: 'ARCHIVED' },
      { currentRuntimeProfileId: null, executorKind: 'USER_BRIDGE' },
    ];
    expect(reusableRuntimeTemplates(runtimes, teammates)).toEqual([runtimes[0]]);
    expect(runtimes).toHaveLength(3);
  });

  it('returns an empty candidate list when every runtime is bound', () => {
    expect(
      reusableRuntimeTemplates([{ id: 'private' }], [{ currentRuntimeProfileId: 'private' }]),
    ).toEqual([]);
  });

  it('allows Endpoint + Model ID without a credential for OpenAI-compatible services', () => {
    const credentialId = newModelCredentialId('OPENAI_COMPATIBLE', '', '', 'local');
    expect(credentialId).toBeNull();
    expect(
      canTestNewModel('OPENAI_COMPATIBLE', 'http://localhost:9999/v1', 'model', credentialId),
    ).toBe(true);
    expect(canTestNewModel('OPENAI_COMPATIBLE', '', 'model', credentialId)).toBe(false);
    expect(
      canTestNewModel('OPENAI_COMPATIBLE', 'http://localhost:9999/v1', ' ', credentialId),
    ).toBe(false);
  });

  it('retains the optional credential imported for the selected compatible provider', () => {
    expect(newModelCredentialId('OPENAI_COMPATIBLE', 'credential', 'local', 'local')).toBe(
      'credential',
    );
  });

  it('never uses an imported credential from a different provider identity', () => {
    expect(
      newModelCredentialId('OPENAI_COMPATIBLE', 'credential', 'old-endpoint', 'new-endpoint'),
    ).toBeNull();
    expect(() => newModelCredentialId('OPENAI', 'credential', 'old', 'new')).toThrow('API Key');
  });

  it.each(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK'] as const)(
    '%s still requires an imported credential before connection testing',
    (kind) => {
      expect(() => newModelCredentialId(kind, '', '', 'provider')).toThrow('API Key');
      expect(canTestNewModel(kind, '', 'model', null)).toBe(false);
      const credentialId = newModelCredentialId(kind, 'credential', 'provider', 'provider');
      expect(canTestNewModel(kind, '', 'model', credentialId)).toBe(true);
    },
  );
});
