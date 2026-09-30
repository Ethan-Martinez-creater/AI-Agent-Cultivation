import type { ProviderKind } from '../ui-shared.js';

export function reusableRuntimeTemplates<T extends { id: string }>(
  runtimes: readonly T[],
  teammates: readonly { currentRuntimeProfileId: string | null }[],
): T[] {
  // Archived teammates retain their sealed execution identity too.
  const boundIds = new Set(teammates.map((teammate) => teammate.currentRuntimeProfileId));
  return runtimes.filter((runtime) => !boundIds.has(runtime.id));
}

export function newModelCredentialId(
  kind: ProviderKind,
  importedId: string,
  importedProviderKey: string,
  providerKey: string,
): string | null {
  const credentialId = importedProviderKey === providerKey ? importedId || null : null;
  if (!credentialId && kind !== 'OPENAI_COMPATIBLE') {
    throw new Error('请先复制 API Key，再通过安全导入完成凭据配置。');
  }
  return credentialId;
}

export function canTestNewModel(
  kind: ProviderKind,
  endpoint: string,
  modelId: string,
  credentialId: string | null,
): boolean {
  return Boolean(modelId.trim() && (kind === 'OPENAI_COMPATIBLE' ? endpoint.trim() : credentialId));
}
