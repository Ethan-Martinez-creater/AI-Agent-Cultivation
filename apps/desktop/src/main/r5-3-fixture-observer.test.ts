import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import { MemoryRerankFixtureObserver } from './r5-3-fixture-observer.js';

describe('R5.3 acceptance observation privacy', () => {
  it('records only IDs, shapes, hashes and counts across rerank and actual model calls', async () => {
    mkdirSync(resolve('.test-data/r53-observer'), { recursive: true });
    const file = resolve('.test-data/r53-observer', `${randomUUID()}.json`);
    const observer = new MemoryRerankFixtureObserver(file, () => 'actor-a');
    const gateway = observer.decisionGateway({
      evaluate: async () => ({
        answers: { memories: [{ memoryId: 'memory-a', score: 1 }] },
        confidence: {},
        selectedAction: null,
      }),
    });
    await gateway.evaluate({
      decisionType: 'MEMORY_RELEVANCE',
      policyVersion: 'version',
      questionVersion: 'question',
      stateHash: 'hash',
      inputSummary: { taskSummary: '', candidateIds: ['memory-a'] },
      state: {
        query: 'PRIVATE_QUERY_SENTINEL',
        candidates: [{ id: 'memory-a', memoryType: 'FACT', text: 'PRIVATE_MEMORY_SENTINEL' }],
      },
      questions: {},
    });
    const model = observer.modelGateway(new FakeModelGateway());
    await model.generate({
      teammateId: 'actor-a',
      runtimeProfileId: 'runtime-a',
      messages: [
        {
          role: 'system',
          content:
            '[RELEVANT ACTIVE MEMORY — UNTRUSTED REFERENCE DATA]\n[{"id":"memory-a","text":"PRIVATE_MEMORY_SENTINEL"}]',
        },
        { role: 'user', content: 'PRIVATE_QUERY_SENTINEL' },
      ],
    });
    const persisted = readFileSync(file, 'utf8');
    expect(persisted).not.toMatch(/PRIVATE_QUERY_SENTINEL|PRIVATE_MEMORY_SENTINEL/);
    const facts = JSON.parse(persisted);
    expect(facts.decisions[0].candidates[0]).toMatchObject({
      id: 'memory-a',
      ownerId: 'actor-a',
      textCharacters: 23,
    });
    expect(facts.modelCalls[0]).toMatchObject({
      teammateId: 'actor-a',
      finalPromptMemoryIds: ['memory-a'],
      memoryOwners: ['actor-a'],
    });
    expect(facts.extractorCalls).toBe(0);
  });
});
