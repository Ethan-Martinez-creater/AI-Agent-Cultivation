import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { DecisionGateway } from '@cultivation/application/r0-decision';
import type { ModelGateway, ModelMessage } from '@cultivation/application';
import type { MemoryRetrievalResult } from '@cultivation/application/gate2-hybrid-memory-service';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Explicit acceptance flags only. Persists IDs/hashes/counts, never semantic text. */
export class MemoryRerankFixtureObserver {
  private readonly decisions: Record<string, unknown>[] = [];
  private readonly retrievals: MemoryRetrievalResult['receipt'][] = [];
  private readonly modelCalls: Record<string, unknown>[] = [];
  private extractorCalls = 0;
  constructor(
    private readonly file: string,
    private readonly ownerOf: (memoryId: string) => string | null,
  ) {}
  private save(): void {
    if ([this.decisions, this.retrievals, this.modelCalls].some((list) => list.length > 256))
      throw new Error('Memory rerank fixture observation bound');
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          decisions: this.decisions,
          retrievals: this.retrievals,
          modelCalls: this.modelCalls,
          extractorCalls: this.extractorCalls,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  record = (receipt: MemoryRetrievalResult['receipt']): void => {
    this.retrievals.push(structuredClone(receipt));
    this.save();
  };
  decisionGateway(gateway: DecisionGateway): DecisionGateway {
    return {
      evaluate: async (request) => {
        const candidates = request.state.candidates as Array<{
          id: string;
          memoryType: string;
          text: string;
        }>;
        const stateText = JSON.stringify(request.state);
        this.decisions.push({
          decisionType: request.decisionType,
          stateHash: request.stateHash,
          policyVersion: request.policyVersion,
          questionVersion: request.questionVersion,
          queryHash: hash(String(request.state.query)),
          stateFields: Object.keys(request.state),
          stateBytes: Buffer.byteLength(stateText, 'utf8'),
          requestBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
          questionKeys: Object.keys(request.questions),
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            ownerId: this.ownerOf(candidate.id),
            memoryType: candidate.memoryType,
            fields: Object.keys(candidate),
            textCharacters: [...candidate.text].length,
            textBytes: Buffer.byteLength(candidate.text, 'utf8'),
            textHash: hash(candidate.text),
          })),
          historyLeak:
            /HISTORY_SENTINEL|FILE_BODY_SENTINEL|PRIVATE_INSTRUCTIONS_SENTINEL|sk-secret/.test(
              stateText,
            ),
        });
        this.save();
        return gateway.evaluate(request);
      },
    };
  }
  modelGateway<T extends ModelGateway>(gateway: T): T {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'extractCandidates')
          return (...args: unknown[]) => {
            this.extractorCalls++;
            this.save();
            return value.apply(target, args);
          };
        if (
          !['stream', 'generate', 'generateWithTools', 'proposeCollaboration'].includes(
            String(property),
          )
        )
          return value.bind(target);
        return (...args: unknown[]) => {
          const request = args[0] as {
            teammateId: string;
            runtimeProfileId: string;
            messages?: ModelMessage[];
            systemContext?: string;
          };
          const system =
            request.systemContext ??
            request.messages
              ?.filter(
                (message) => message.role === 'system' && typeof message.content === 'string',
              )
              .map((message) => message.content)
              .join('\n') ??
            '';
          const match = /\[RELEVANT ACTIVE MEMORY[^\n]*\]\n([^\n]*)/.exec(system);
          const memories: Array<{ id: string }> = match ? JSON.parse(match[1]!) : [];
          this.modelCalls.push({
            teammateId: request.teammateId,
            runtimeProfileId: request.runtimeProfileId,
            method: String(property),
            finalPromptMemoryIds: memories.map((memory) => memory.id),
            memoryOwners: memories.map((memory) => this.ownerOf(memory.id)),
            memorySectionCharacters: match?.[0].length ?? 0,
          });
          this.save();
          return value.apply(target, args);
        };
      },
    });
  }
}
