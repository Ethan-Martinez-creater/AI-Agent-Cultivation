import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionGateway } from '@cultivation/application/r0-decision';
import type { CompletionAdvisoryPort } from '@cultivation/application/r5-5-completion-advisory';
import type { ModelGateway, ModelRequest, WorkflowService } from '@cultivation/application';
import type { WorkflowStepDefinition, WorkflowVersion } from '@cultivation/domain';

/** Explicit isolated smoke only; no request/result text, private context, or tool bodies in facts. */
export class CompletionAdvisoryFixtureObserver {
  private readonly decisions: Record<string, unknown>[];
  private readonly modelCalls: Record<string, unknown>[];
  private readonly receipts: Record<string, unknown>[];
  constructor(private readonly file: string) {
    const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.decisions = old.decisions ?? [];
    this.modelCalls = old.modelCalls ?? [];
    this.receipts = old.receipts ?? [];
  }
  private save(): void {
    if ([this.decisions, this.modelCalls, this.receipts].some((items) => items.length > 512))
      throw new Error('Completion fixture limit');
    writeFileSync(
      this.file,
      JSON.stringify(
        { decisions: this.decisions, modelCalls: this.modelCalls, receipts: this.receipts },
        null,
        2,
      ),
      'utf8',
    );
  }
  decisionGateway(gateway: DecisionGateway): DecisionGateway {
    return {
      evaluate: async (request) => {
        const context = request.state.context as Record<string, unknown>;
        const observation: Record<string, unknown> = {
          type: request.decisionType,
          decisionType: request.decisionType,
          actorId: context.actorId,
          phase: context.phase,
          missionId: context.missionId,
          runId: context.runId,
          stateHash: request.stateHash,
          questionVersion: request.questionVersion,
          policyVersion: request.policyVersion,
          stateBytes: Buffer.byteLength(JSON.stringify(request.state)),
          requestBytes: Buffer.byteLength(JSON.stringify(request)),
          stateFields: Object.keys(request.state),
          questionKeys: Object.keys(request.questions),
          resultType: (request.state.result as Record<string, unknown>)?.type,
          forbiddenDataSeen:
            /MEMORY_SENTINEL|SKILL_BODY_SENTINEL|TOOL_OUTPUT_SENTINEL|ENV_SECRET_SENTINEL|sk-secret/.test(
              JSON.stringify(request.state),
            ),
        };
        this.decisions.push(observation);
        const result = await gateway.evaluate(request);
        const concern = String(context.objective).includes('[R55_CONCERN]');
        const inconsistent = String(context.objective).includes('[R55_INCONSISTENT]');
        const answers = concern
          ? { needs_review: 'YES', objective_satisfied: 'NO', should_continue: 'YES' }
          : inconsistent
            ? { needs_review: 'NO', objective_satisfied: 'YES', should_continue: 'YES' }
            : { needs_review: 'NO', objective_satisfied: 'YES', should_continue: 'NO' };
        const response = { ...result, answers };
        observation.values = answers;
        observation.responseBytes = Buffer.byteLength(JSON.stringify(response));
        this.save();
        return response;
      },
    };
  }
  advisoryPort(port: CompletionAdvisoryPort): CompletionAdvisoryPort {
    return {
      assess: async (context, canDispatch) => {
        const receipt = await port.assess(context, canDispatch);
        this.receipts.push({ ...receipt });
        const decision = [...this.decisions]
          .reverse()
          .find((item) => item.stateHash === receipt.stateHash);
        if (decision)
          Object.assign(decision, {
            disposition: receipt.disposition,
            objectiveHash: receipt.objectiveHash,
            resultHash: receipt.resultHash,
          });
        this.save();
        return receipt;
      },
    };
  }
  modelGateway<T extends ModelGateway>(gateway: T): T {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'generate' && property !== 'generateWithTools') return value.bind(target);
        return async (request: ModelRequest) => {
          this.modelCalls.push({
            method: property,
            teammateId: request.teammateId,
            runtimeProfileId: request.runtimeProfileId,
            structured: request.participantOutcomeContract === 'g3-v1',
          });
          this.save();
          const response = await value.call(target, request);
          const prompt = request.messages.find((message) => message.role === 'user')?.content;
          if (typeof prompt === 'string' && prompt.startsWith('__R55_REVIEW__')) {
            const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]!);
            return {
              ...response,
              text: JSON.stringify({
                verdict: 'REVISE',
                findings: ['需要补充验证'],
                evidence: [],
                summary: '请修订',
                reviewedArtifactIds: ids,
              }),
            };
          }
          return response;
        };
      },
    });
  }
}

export function registerCompletionAdvisoryWorkflowFixtures(service: WorkflowService): void {
  const task: WorkflowStepDefinition = {
    id: 'draft',
    title: '生成草稿',
    objective: '[R55_SATISFIED] Produce the requested summary',
    type: 'TASK',
    routing: { executionConstraint: 'SOLO', requiredCapabilities: ['GENERAL_REASONING'] },
    inputs: [],
    outputs: [
      {
        key: 'summary',
        kind: 'TEXT',
        required: true,
        contractId: 'fixture.r55-text',
        contractVersion: '1',
        maxSizeBytes: 16384,
        description: '',
        validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
      },
    ],
    exitCondition: 'VALID_OUTPUTS',
    maxAttempts: 2,
    effectType: 'NONE',
  };
  const version: WorkflowVersion = {
    definition: {
      id: 'r55-fixture-output-invalid',
      name: '结果验证',
      description: '',
      source: 'USER',
      category: 'test',
    },
    version: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    entryStepId: task.id,
    referenceBasis: [],
    edges: [],
    steps: [
      {
        ...task,
        outputs: [
          {
            ...task.outputs[0]!,
            kind: 'JSON',
            validator: { type: 'JSON', requiredKeys: ['answer'] },
          },
        ],
      },
    ],
  };
  service.publish(version);
  service.publish({
    ...version,
    definition: { ...version.definition, id: 'r55-fixture-review-revise', name: '审查验证' },
    steps: [
      task,
      {
        ...task,
        id: 'review',
        title: '审查',
        objective: '__R55_REVIEW__ [R55_SATISFIED] Review the supplied draft',
        type: 'REVIEW',
        exitCondition: 'REVIEW_PASS',
        inputs: [{ key: 'draft', fromStepId: task.id, outputKey: 'summary', required: true }],
        outputs: [
          {
            ...task.outputs[0]!,
            key: 'review',
            kind: 'JSON',
            validator: {
              type: 'JSON',
              requiredKeys: ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'],
            },
          },
        ],
      },
    ],
    edges: [
      {
        id: 'draft-review',
        fromStepId: task.id,
        toStepId: 'review',
        branch: 'NEXT',
        condition: { type: 'ALWAYS' },
      },
    ],
  });
}
