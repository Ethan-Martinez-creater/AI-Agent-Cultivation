import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@cultivation/domain';
import { generationDecisionEvidence } from './generation-decision-evidence.js';

describe('Main-only production decision evidence', () => {
  it('records a bounded pre-gate decision and actual extractor outcome without message text', () => {
    const events: AuditEvent[] = [];
    const observer = generationDecisionEvidence((e) => events.push(e));
    observer.preGate({
      ownerId: 'teammate',
      sourceId: 'message',
      sourceType: 'CHAT_MESSAGE',
      trigger: 'USER_EXPLICIT',
      mode: 'JEV',
      decision: 'SKIP_EXTRACTION',
      confidence: 0.9,
      stateHash: 'a'.repeat(64),
      policyVersion: 'v1',
      questionVersion: 'v1',
      reason: 'JEV_DECISION',
      errorCode: null,
      extractorInvoked: false,
      candidateCount: 0,
    });
    expect(events[0]).toMatchObject({
      action: 'memory.pre_gate',
      actorId: 'teammate',
      targetId: 'message',
      payloadJson: { mode: 'JEV', extractorInvoked: false, candidateCount: 0 },
    });
    expect(JSON.stringify(events)).not.toMatch(/content|prompt|apiKey/);
  });
  it('records candidate/order/selected IDs and text hashes without raw private Memory', () => {
    const events: AuditEvent[] = [];
    const observer = generationDecisionEvidence((e) => events.push(e));
    observer.rerank({
      teammateId: 'teammate',
      baselineIds: ['a', 'b'],
      orderedIds: ['b', 'a'],
      candidateIds: ['a', 'b'],
      selectedIds: ['b', 'a'],
      mode: 'JEV',
      reason: 'JEV_RERANKED',
      errorCode: null,
      queryHash: 'q'.repeat(64),
      stateHash: 's'.repeat(64),
      policyVersion: 'v1',
      questionVersion: 'v1',
      scores: [
        { memoryId: 'b', score: 0.9 },
        { memoryId: 'a', score: 0.4 },
      ],
      candidateTextFacts: [
        {
          memoryId: 'b',
          source: 'SUMMARY',
          characters: 20,
          utf8Bytes: 20,
          textHash: 'h'.repeat(64),
        },
      ],
    });
    expect(events[0]).toMatchObject({
      action: 'memory.rerank',
      payloadJson: { selectedIds: ['b', 'a'], orderedIds: ['b', 'a'] },
    });
    expect(JSON.stringify(events)).not.toContain('private Memory');
  });
});
