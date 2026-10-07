import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DecisionGateway } from '@cultivation/application/r0-decision';
import type { MemoryCandidateExtractor, ModelGateway } from '@cultivation/application';
import type { MemoryProposalResult } from '@cultivation/application/gate2-memory-service';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Constructed only under two explicit test flags; no raw source or provider body is stored. */
export class MemoryPreGateFixtureObserver {
  private readonly decisions: Record<string, unknown>[] = [];
  private readonly extractions: Record<string, unknown>[] = [];
  private readonly receipts: MemoryProposalResult['gate'][] = [];
  constructor(private readonly file: string) {}
  private save(): void {
    if ([this.decisions, this.extractions, this.receipts].some((list) => list.length > 128))
      throw new Error('Memory Pre-Gate fixture evidence bound');
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          decisions: this.decisions,
          extractions: this.extractions,
          receipts: this.receipts,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  record = (receipt: MemoryProposalResult['gate']): void => {
    this.receipts.push(structuredClone(receipt));
    this.save();
  };
  decisionGateway(gateway: DecisionGateway): DecisionGateway {
    return {
      evaluate: async (request) => {
        const state = request.state;
        const execution = state.execution as Record<string, unknown> | undefined;
        this.decisions.push({
          decisionType: request.decisionType,
          policyVersion: request.policyVersion,
          questionVersion: request.questionVersion,
          stateHash: request.stateHash,
          stateBytes: Buffer.byteLength(JSON.stringify(state), 'utf8'),
          stateKeys: Object.keys(state),
          sourceType: state.sourceType,
          trigger: state.trigger,
          messageRole: state.messageRole,
          evidence: state.evidence,
          executionFields: execution ? Object.keys(execution) : [],
          executionHash: execution ? hash(JSON.stringify(execution)) : null,
          privateSentinelPresent: /PRIVATE_|HISTORY_SENTINEL|FILE_BODY_SENTINEL|sk-secret/.test(
            JSON.stringify(state),
          ),
        });
        this.save();
        return gateway.evaluate(request);
      },
    };
  }
  modelGateway<T extends ModelGateway & MemoryCandidateExtractor>(gateway: T): T {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'extractCandidates') return value.bind(target);
        return async (request: Parameters<MemoryCandidateExtractor['extractCandidates']>[0]) => {
          this.extractions.push({
            teammateId: request.teammateId,
            runtimeProfileId: request.runtimeProfileId,
            evidenceHash: hash(request.evidence),
            evidenceCharacters: request.evidence.length,
          });
          this.save();
          return value.call(target, request);
        };
      },
    });
  }
}
