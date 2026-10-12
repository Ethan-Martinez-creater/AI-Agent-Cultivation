import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@cultivation/domain';
import type { MemoryProposalResult } from '@cultivation/application/gate2-memory-service';
import type { MemoryRetrievalResult } from '@cultivation/application/gate2-hybrid-memory-service';

/** Persist bounded Jev/fallback receipts in normal Main, with no raw Memory or query text. */
export function generationDecisionEvidence(append: (event: AuditEvent) => void) {
  const write = (
    action: string,
    actorId: string,
    targetId: string,
    payloadJson: Record<string, unknown>,
  ) =>
    append({
      id: randomUUID(),
      actorType: 'TEAMMATE',
      actorId,
      action,
      targetType: 'DECISION_RECEIPT',
      targetId,
      payloadJson,
      createdAt: new Date().toISOString(),
    });
  return {
    preGate: (receipt: MemoryProposalResult['gate']) =>
      write('memory.pre_gate', receipt.ownerId, receipt.sourceId, { ...receipt }),
    rerank: (receipt: MemoryRetrievalResult['receipt']) =>
      write('memory.rerank', receipt.teammateId, receipt.stateHash, { ...receipt }),
  };
}
