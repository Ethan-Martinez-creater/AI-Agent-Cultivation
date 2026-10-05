import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvailabilityBadge } from '../r3-2-availability.js';
import { canTestNewModel, newModelCredentialId } from './create-model-policy.js';
import { errorCodeOf, generationErrorText } from './generation-chat.js';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('G2 Generation single chat UI contracts', () => {
  it('allows an optional credential while requiring the configured endpoint and minimax-h3 identity', () => {
    const credentialId = newModelCredentialId('GENERATION_HTTP', '', '', 'provider-key');
    expect(credentialId).toBeNull();
    expect(
      canTestNewModel('GENERATION_HTTP', 'https://generation.example', 'minimax-h3', credentialId),
    ).toBe(true);
    expect(canTestNewModel('GENERATION_HTTP', '', 'minimax-h3', credentialId)).toBe(false);
    expect(
      canTestNewModel(
        'GENERATION_HTTP',
        'https://generation.example',
        'another-model',
        credentialId,
      ),
    ).toBe(false);

    const wizard = readSource('./create-teammate.tsx').replace(/\s+/g, ' ');
    expect(wizard).toContain(
      "providerKind === 'OPENAI_COMPATIBLE' || providerKind === 'GENERATION_HTTP'",
    );
    expect(wizard).toMatch(
      /setExecutionProtocol\(\s*nextKind === 'GENERATION_HTTP' \? 'GENERATION' : 'LANGUAGE',?\s*\)/,
    );
    expect(wizard).toContain(
      "disabled={busy || Boolean(draftRuntimeId) || providerKind === 'GENERATION_HTTP'}",
    );
    expect(wizard).toContain("modelId.trim() !== 'minimax-h3'");
    expect(wizard).toContain("...(providerKind === 'GENERATION_HTTP' ? { adapterId: 'H3' } : {})");
    expect(wizard).toContain('window.cultivation.credentials.create({');
    expect(wizard).not.toMatch(/navigator\.clipboard/);
  });

  it('uses only the typed GenerationChat bridge and does not expose local paths or secrets', () => {
    const shared = readSource('../ui-shared.tsx');
    const bridgeStart = shared.indexOf('export interface GenerationChatBridge {');
    const bridgeEnd = shared.indexOf('\n}', bridgeStart);
    const bridge = shared.slice(bridgeStart, bridgeEnd);
    for (const method of [
      'listConversations(',
      'createConversation(',
      'detail(',
      'send(',
      'descriptor(',
      'listAttachments(',
      'importAttachment(',
      'artifactUrl(',
      'refresh(',
    ]) {
      expect(bridge).toContain(method);
    }
    expect(shared).toContain("Omit<GenerationArtifact, 'storageKey'>");
    expect(bridge).toContain('importAttachment(): Promise<GenerationAttachmentView | null>');
    expect(bridge).toContain('artifactUrl(id: string): Promise<string>');

    const generationChat = readSource('./generation-chat.tsx');
    expect(generationChat).toContain('window.cultivation.generationChat.importAttachment()');
    expect(generationChat).toContain('window.cultivation.generationChat.artifactUrl(artifact.id)');
    expect(generationChat).not.toMatch(/\bfetch\s*\(/);
    expect(generationChat).not.toMatch(
      /\b(?:apiKey|storageKey|filePath|providerUrl|credentialValue)\b/i,
    );
  });

  it('renders only descriptor-supported parameter fields and requires an explicit allowed input role', () => {
    const source = readSource('./generation-chat.tsx');
    const supportedKeys = source.match(
      /const supported: SupportedParameterKey\[\] = (\[[^\]]+\]);/,
    )?.[1];
    expect(supportedKeys).toBe("['duration', 'aspect', 'seed', 'nativeAudio']");
    expect(source).toContain(
      "key === 'duration' && (propertyType === 'number' || propertyType === 'integer')",
    );
    expect(source).toContain("key === 'aspect' && propertyType === 'string'");
    expect(source).toContain(
      "key === 'seed' && (propertyType === 'number' || propertyType === 'integer')",
    );
    expect(source.replace(/\s+/g, ' ')).toContain(
      "key === 'nativeAudio' && propertyType === 'boolean' && descriptor.featureTags.includes('NATIVE_AUDIO')",
    );
    expect(source).toContain('descriptor.inputRoles.filter((role) => {');
    expect(source).toContain('const roles = allowedInputRoles(descriptor, attachment);');
    expect(source).toContain('value={role.role}');
    expect(source).toContain('inputs.map(({ artifactId, role }) => ({ artifactId, role }))');
    expect(source).toContain('input.role),\n  );');
  });

  it('refreshes UNKNOWN jobs without automatically resubmitting them', () => {
    const source = readSource('./generation-chat.tsx');
    expect(source).toContain("new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'])");
    const pollStart = source.indexOf('const activeJobs = detail?.entries.some(');
    const pollEnd = source.indexOf(
      'useEffect(() => {\n    if (messageStreamRef.current)',
      pollStart,
    );
    const polling = source.slice(pollStart, pollEnd);
    expect(polling).toContain('.refresh({ teammateId, conversationId })');
    expect(polling).not.toContain('.send(');
    expect(source.match(/window\.cultivation\.generationChat\.send\(/g)).toHaveLength(1);
  });

  it('keeps generation entries to the user prompt, job state, and artifact card', () => {
    const source = readSource('./generation-chat.tsx');
    const entryStart = source.indexOf('function GenerationEntry(');
    const artifactStart = source.indexOf('function GenerationArtifactCard(', entryStart);
    const entry = source.slice(entryStart, artifactStart);
    expect(entry).toContain("entry.message.role === 'USER'");
    expect(entry).toContain('{entry.job && (');
    expect(entry).toContain('<GenerationArtifactCard');
    expect(entry).not.toContain("entry.message.role === 'ASSISTANT'");
    expect(source).not.toMatch(/<textarea[\s\S]*?placeholder=/);
  });

  it('loads saved generation history before probing active models, including archived teammates', () => {
    const source = readSource('./generation-chat.tsx');
    const initialLoadStart = source.indexOf('void Promise.all([');
    const initialLoadEnd = source.indexOf('const activeJobs =', initialLoadStart);
    const initialLoad = source.slice(initialLoadStart, initialLoadEnd);
    const detailIndex = initialLoad.indexOf(
      'if (rows[0]) await loadDetail(teammateId, rows[0].id);',
    );
    const archiveGuardIndex = initialLoad.indexOf(
      "if (cancelled || found.status !== 'ACTIVE') return;",
    );
    const descriptorIndex = initialLoad.indexOf('generationChat.descriptor(teammateId)');
    expect(detailIndex).toBeGreaterThanOrEqual(0);
    expect(detailIndex).toBeLessThan(archiveGuardIndex);
    expect(archiveGuardIndex).toBeLessThan(descriptorIndex);
    expect(initialLoad).not.toContain("found.status !== 'ACTIVE' ||");
  });

  it('does not render or query model availability for Human Bridge teammates', () => {
    expect(
      renderToStaticMarkup(
        createElement(AvailabilityBadge, {
          teammateId: 'human-bridge',
          executorKind: 'USER_BRIDGE',
        }),
      ),
    ).toBe('');

    const availability = readSource('../r3-2-availability.tsx');
    const effectStart = availability.indexOf('useEffect(() => {');
    const effectEnd = availability.indexOf(
      '}, [teammateId, runtimeProfileId, teammateStatus, executorKind]);',
      effectStart,
    );
    const effect = availability.slice(effectStart, effectEnd);
    expect(effect.indexOf("if (executorKind === 'USER_BRIDGE') return;")).toBeGreaterThanOrEqual(0);
    expect(effect.indexOf("if (executorKind === 'USER_BRIDGE') return;")).toBeLessThan(
      effect.indexOf('window.cultivation.availability.'),
    );
  });

  it('parses only stable IPC error prefixes and never renders SDK error text', () => {
    expect(
      errorCodeOf(
        new Error(
          "Error invoking remote method 'generationChat:send': Error: MODEL_UNAVAILABLE: 生成操作未能安全完成",
        ),
      ),
    ).toBe('MODEL_UNAVAILABLE');
    expect(errorCodeOf(new Error('MODEL_UNAVAILABLE: 生成操作未能安全完成'))).toBe(
      'MODEL_UNAVAILABLE',
    );
    expect(
      generationErrorText(
        new Error('MODEL_UNAVAILABLE: secret provider response'),
        '生成任务失败。',
      ),
    ).toBe('生成服务暂时不可用，请重新检测后再决定是否重试。');
    expect(
      generationErrorText(
        new Error('GENERATION_FAILED: secret provider response'),
        '生成任务失败。',
      ),
    ).toBe('生成任务失败。（GENERATION_FAILED）');
    expect(generationErrorText(new Error('secret provider response'), '生成任务失败。')).toBe(
      '生成任务失败。',
    );
  });

  it('routes only Generation HTTP models to the new page and keeps language chat on its existing bridge', () => {
    const source = readSource('./chat.tsx');
    expect(source).toContain(
      "runtime?.executionProtocol === 'GENERATION' && provider?.kind === 'GENERATION_HTTP'",
    );
    expect(source).toContain(
      'navigate(`/generation-chat/${encodeURIComponent(teammateId)}`, { replace: true })',
    );
    expect(source).toContain('window.cultivation.chat.listConversations(teammateId)');
    expect(source).toMatch(
      /window\.cultivation\.chat\s*\.listMessages\(\{ teammateId, conversationId: initialConversationId \}\)/,
    );
    expect(source).toContain('window.cultivation.chat.send({');
  });
});
