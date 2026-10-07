import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionGateway } from '@cultivation/application/r0-decision';
import type { ModelGateway, ModelToolResponse, WorkflowService } from '@cultivation/application';
import type { ToolDescriptor, WorkflowVersion } from '@cultivation/domain';

/** Explicit test flags only. No source text, arguments, schema or output bodies are persisted. */
export class ToolShortlistFixtureObserver {
  private readonly decisions: Record<string, unknown>[];
  private readonly modelCalls: Record<string, unknown>[];
  constructor(
    private readonly file: string,
    private readonly tools: () => ToolDescriptor[],
  ) {
    const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.decisions = old.decisions ?? [];
    this.modelCalls = old.modelCalls ?? [];
  }
  private save(): void {
    if (this.decisions.length > 256 || this.modelCalls.length > 256)
      throw new Error('Tool fixture observation limit');
    writeFileSync(
      this.file,
      JSON.stringify({ decisions: this.decisions, modelCalls: this.modelCalls }, null, 2),
      'utf8',
    );
  }
  decisionGateway(gateway: DecisionGateway): DecisionGateway {
    return {
      evaluate: async (request) => {
        const candidates = request.state.candidates as Array<{ id: string }>;
        const observation: Record<string, unknown> = {
          decisionType: request.decisionType,
          stateHash: request.stateHash,
          policyVersion: request.policyVersion,
          questionVersion: request.questionVersion,
          stateFields: Object.keys(request.state),
          stateBytes: Buffer.byteLength(JSON.stringify(request.state)),
          requestBytes: Buffer.byteLength(JSON.stringify(request)),
          questionKeys: Object.keys(request.questions),
          candidateIds: candidates.map(({ id }) => id),
          candidateFields: candidates.map((candidate) => Object.keys(candidate)),
          contextHash: createHash('sha256')
            .update(JSON.stringify(request.state.context))
            .digest('hex'),
          forbiddenDataSeen: /BODY_SENTINEL|HISTORY_SENTINEL|ENV_SECRET_SENTINEL|sk-secret/.test(
            JSON.stringify(request.state),
          ),
        };
        this.decisions.push(observation);
        this.save();
        const result = await gateway.evaluate(request);
        observation.responseBytes = Buffer.byteLength(JSON.stringify(result));
        this.save();
        return result;
      },
    };
  }
  modelGateway<T extends ModelGateway>(gateway: T): T {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'generateWithTools') return value.bind(target);
        return async (request: Parameters<NonNullable<ModelGateway['generateWithTools']>>[0]) => {
          const user = request.messages.find((message) => message.role === 'user')?.content;
          const prompt = typeof user === 'string' ? user : '';
          let response: ModelToolResponse;
          if (/__R54_(?:READ|WRITE|PARTY|WORKFLOW|MCP|NOT_OFFERED)__/.test(prompt)) {
            const hasCall = request.messages.some(
              (message) =>
                message.role === 'assistant' &&
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === 'tool-call'),
            );
            const write = prompt.includes('__R54_WRITE__');
            const mcpName = prompt.includes('__R54_NOT_OFFERED__')
              ? 'excluded'
              : prompt.includes('__R54_MCP__')
                ? 'research_read'
                : null;
            const toolId = mcpName
              ? (this.tools().find(
                  (tool) => tool.name === mcpName || tool.name.endsWith(`.${mcpName}`),
                )?.id ?? 'unavailable-mcp')
              : write
                ? 'file.writeText'
                : 'file.readText';
            const fixtureCallId = createHash('sha256')
              .update(request.teammateId)
              .update(prompt)
              .digest('hex')
              .slice(0, 16);
            const toolCalls = hasCall
              ? []
              : [
                  {
                    id: `r54-call-${fixtureCallId}-${request.messages.length}`,
                    toolId,
                    input: mcpName
                      ? {}
                      : write
                        ? { path: 'r54-output.txt', content: '交付已完成' }
                        : { path: 'r54-input.txt' },
                  },
                ];
            request.onCallStarted?.();
            const final = prompt.includes('__R54_WORKFLOW__')
              ? JSON.stringify({ summary: '验证已完成' })
              : prompt.includes('__R54_PARTY__')
                ? '__R54_PARTY__ 任务已完成，结果已核验。'
                : '任务已完成，结果已核验。';
            response = {
              toolCalls,
              text: toolCalls.length
                ? ''
                : request.participantOutcomeContract
                  ? JSON.stringify({ kind: 'RESULT', publicResult: final, artifactRefs: [] })
                  : final,
              usage: {
                inputTokens: 20,
                outputTokens: 5,
                cachedInputTokens: null,
                reasoningTokens: null,
              },
            };
          } else response = await value.call(target, request);
          this.modelCalls.push({
            teammateId: request.teammateId,
            runtimeProfileId: request.runtimeProfileId,
            offeredIds: request.tools.map(({ id }) => id),
            proposedIds: response.toolCalls.map(({ toolId }) => toolId),
            method: 'generateWithTools',
          });
          this.save();
          return response;
        };
      },
    });
  }
}

/** An isolated USER fixture, not an official package; never loaded on normal launch. */
export function registerToolShortlistWorkflowFixture(service: WorkflowService): void {
  const version: WorkflowVersion = {
    definition: {
      id: 'r54-fixture-tools',
      name: '工具链验证',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    entryStepId: 'read',
    referenceBasis: [],
    steps: [
      {
        id: 'read',
        title: '验证',
        objective: '__R54_WORKFLOW__ read the approved workspace file',
        type: 'TASK',
        routing: {
          executionConstraint: 'SOLO',
          requiredCapabilities: ['GENERAL_REASONING', 'TOOL_USE'],
        },
        inputs: [],
        outputs: [
          {
            key: 'summary',
            kind: 'TEXT',
            required: true,
            contractId: 'fixture.r54-summary',
            contractVersion: '1',
            maxSizeBytes: 16384,
            description: '',
            validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
          },
        ],
        exitCondition: 'VALID_OUTPUTS',
        maxAttempts: 2,
        effectType: 'NONE',
      },
    ],
    edges: [],
  };
  service.publish(version);
}
