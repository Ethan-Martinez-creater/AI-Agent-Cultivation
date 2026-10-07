import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelGateway, MemoryCandidateExtractor } from '@cultivation/application';
import {
  MemoryPreGateService,
  buildMemoryEvidenceFacts,
} from '@cultivation/application/r5-2-memory-pre-gate';
import { MemoryPreGateFixtureObserver } from './r5-2-fixture-observer.js';

describe('R5.2 test-only bounded observer', () => {
  it('observes real extractor invocation and hashes without copying raw evidence or Memory', async () => {
    const file = join(mkdtempSync(join(process.cwd(), '.test-data/r52-observer-')), 'facts.json');
    const observer = new MemoryPreGateFixtureObserver(file);
    const evidence = 'I prefer PRIVATE_MEMORY_BODY and sk-secret-12345678901234567890';
    const extractCandidates = vi.fn(async () => ({
      candidates: [],
      usage: { inputTokens: 2, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null },
    }));
    const gateway = observer.modelGateway({ extractCandidates } as unknown as ModelGateway &
      MemoryCandidateExtractor);
    await gateway.extractCandidates({ teammateId: 'a', runtimeProfileId: 'r', evidence });
    const gate = new MemoryPreGateService(async () =>
      observer.decisionGateway({
        evaluate: async () => ({
          answers: { extraction: 'RUN_EXTRACTION' },
          confidence: { extraction: 1 },
          selectedAction: null,
        }),
      }),
    );
    const receipt = await gate.evaluate({
      ownerId: 'a',
      sourceId: 'source',
      sourceType: 'CHAT_MESSAGE',
      trigger: 'USER_EXPLICIT',
      messageRole: 'user',
      ...buildMemoryEvidenceFacts(evidence),
    });
    observer.record({ ...receipt, extractorInvoked: true, candidateCount: 0 });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toMatch(/PRIVATE_MEMORY_BODY|sk-secret|I prefer/);
    const facts = JSON.parse(raw);
    expect(facts.extractions).toHaveLength(1);
    expect(facts.extractions[0]).toMatchObject({ teammateId: 'a', runtimeProfileId: 'r' });
    expect(facts.decisions[0]).toMatchObject({
      sourceType: 'CHAT_MESSAGE',
      privateSentinelPresent: false,
    });
    expect(facts.receipts[0]).toMatchObject({ decision: 'RUN_EXTRACTION', extractorInvoked: true });
    expect(extractCandidates).toHaveBeenCalledWith({
      teammateId: 'a',
      runtimeProfileId: 'r',
      evidence,
    });
  });
});
