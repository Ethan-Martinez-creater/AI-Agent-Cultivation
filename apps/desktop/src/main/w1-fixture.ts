import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelRequest, ModelToolResponse, WorkflowService } from '@cultivation/application';
import type {
  WorkflowArtifactSpec,
  WorkflowStepDefinition,
  WorkflowVersion,
} from '@cultivation/domain';

/** Test-only, selected by an explicit package smoke flag. Never registers official/user templates. */
export class WorkflowFixtureGateway extends FakeModelGateway {
  override async generate(request: ModelRequest) {
    const original = await super.generate(request);
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    if (prompt.startsWith('__W1_CRASH__')) await new Promise<void>(() => {});
    if (prompt.startsWith('__W1_REVIEW__')) {
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]!);
      return {
        ...original,
        text: JSON.stringify({
          verdict: 'PASS',
          findings: [],
          evidence: ['Validated fixture artifact'],
          summary: 'Bounded fixture review',
          reviewedArtifactIds: ids,
        }),
      };
    }
    if (prompt.startsWith('__W1_BAD_OUTPUT__'))
      return { ...original, text: 'A model claim of completion is not JSON.' };
    if (
      prompt.startsWith('__W1_') ||
      (prompt.startsWith('SYNTHESIS:') && prompt.includes('__W1_PARTY__'))
    )
      return { ...original, text: '{"ok":true,"summary":"W1 fixture persisted result"}' };
    return original;
  }
  override async generateWithTools(
    request: Parameters<NonNullable<FakeModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const prompt = request.messages.find((m) => m.role === 'user')?.content;
    if (
      typeof prompt === 'string' &&
      prompt.startsWith('__W1_TOOL_WAIT__') &&
      !request.messages.some((m) => m.role === 'tool')
    ) {
      return {
        text: '',
        usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null },
        toolCalls: [
          {
            id: 'w1-file-call',
            toolId: 'file.writeText',
            input: { path: 'workflow-result.txt', content: 'W1 approved file fixture' },
          },
        ],
      };
    }
    return super.generateWithTools(request);
  }
}
const json = (key: string): WorkflowArtifactSpec => ({
  key,
  kind: 'JSON',
  required: true,
  contractId: `fixture.${key}`,
  contractVersion: '1',
  maxSizeBytes: 16_384,
  description: 'W1 acceptance fixture',
  validator: { type: 'JSON', requiredKeys: ['ok'] },
});
const step = (id: string, objective: string): WorkflowStepDefinition => ({
  id,
  title: id,
  objective,
  type: 'TASK',
  routing: { executionConstraint: 'SOLO', requiredCapabilities: ['GENERAL_REASONING'] },
  inputs: [],
  outputs: [json(id)],
  exitCondition: 'VALID_OUTPUTS',
  maxAttempts: 3,
  effectType: 'NONE',
});
export function registerWorkflowFixtures(service: WorkflowService): void {
  const createdAt = '2026-10-01T00:00:00.000Z';
  const versions: WorkflowVersion[] = [];
  const task = step('draft', '__W1_TASK__');
  const review: WorkflowStepDefinition = {
    ...step('review', '__W1_REVIEW__'),
    type: 'REVIEW',
    inputs: [{ key: 'draft', fromStepId: 'draft', outputKey: 'draft', required: true }],
    outputs: [
      {
        ...json('review'),
        validator: {
          type: 'JSON',
          requiredKeys: ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'],
        },
      },
    ],
  };
  const decision: WorkflowStepDefinition = {
    ...step('decision', 'Read the structured review verdict'),
    type: 'DECISION',
    inputs: [{ key: 'review', fromStepId: 'review', outputKey: 'review', required: true }],
    outputs: [],
  };
  versions.push({
    definition: {
      id: 'w1-fixture-sequence',
      name: 'W1 顺序验收夹具',
      description: 'TASK → REVIEW → DECISION；非官方模板',
      source: 'USER',
      category: 'TEST_ONLY',
    },
    version: 1,
    entryStepId: 'draft',
    steps: [
      task,
      review,
      decision,
      step('delivery', '__W1_DELIVERY__'),
      step('blocked', '__W1_BLOCKED__'),
    ],
    edges: [
      {
        id: 'draft-review',
        fromStepId: 'draft',
        toStepId: 'review',
        branch: 'NEXT',
        condition: { type: 'ALWAYS' },
      },
      {
        id: 'review-decision',
        fromStepId: 'review',
        toStepId: 'decision',
        branch: 'NEXT',
        condition: { type: 'ALWAYS' },
      },
      {
        id: 'pass-delivery',
        fromStepId: 'decision',
        toStepId: 'delivery',
        branch: 'PASS',
        condition: {
          type: 'JSON_FIELD_EQUALS',
          inputKey: 'review',
          field: 'verdict',
          equals: 'PASS',
        },
      },
      {
        id: 'fail-blocked',
        fromStepId: 'decision',
        toStepId: 'blocked',
        branch: 'FAIL',
        condition: {
          type: 'JSON_FIELD_EQUALS',
          inputKey: 'review',
          field: 'verdict',
          equals: 'FAIL',
        },
      },
    ],
    referenceBasis: [],
    createdAt,
  });
  for (const [id, objective] of [
    ['approval', '__W1_TOOL_WAIT__'],
    ['crash', '__W1_CRASH__'],
    ['invalid', '__W1_BAD_OUTPUT__'],
  ]) {
    const task = step(id!, objective!);
    versions.push({
      definition: {
        id: `w1-fixture-${id}`,
        name: `W1 ${id} 验收夹具`,
        description: 'Test-only recovery fixture',
        category: 'TEST_ONLY',
        source: 'USER',
      },
      version: 1,
      entryStepId: task.id,
      steps: [task],
      edges: [],
      referenceBasis: [],
      createdAt,
    });
  }
  const human = {
    ...step('external', 'W1 Human Bridge deliverable'),
    routing: {
      executionConstraint: 'HUMAN_BRIDGE' as const,
      requiredCapabilities: ['GENERAL_REASONING' as const],
      expectedOutputContract: {
        name: 'w1-result.txt',
        allowedExtensions: ['.txt'],
        maxSizeBytes: 16_384,
      },
    },
    outputs: [
      {
        key: 'w1-result.txt',
        kind: 'FILE' as const,
        required: true,
        contractId: 'fixture.external-file',
        contractVersion: '1',
        maxSizeBytes: 16_384,
        description: 'Verified accepted external file',
        validator: { type: 'METADATA' as const, allowedExtensions: ['.txt'] },
      },
    ],
    effectType: 'EXTERNAL_ACTION' as const,
  };
  versions.push({
    definition: {
      id: 'w1-fixture-external',
      name: 'W1 本尊验收夹具',
      description: 'Test-only external recovery fixture',
      category: 'TEST_ONLY',
      source: 'USER',
    },
    version: 1,
    entryStepId: human.id,
    steps: [human],
    edges: [],
    referenceBasis: [],
    createdAt,
  });
  const party = {
    ...step('party', '__W1_PARTY__'),
    routing: {
      executionConstraint: 'PARTY' as const,
      partyMode: 'CONSULTATION' as const,
      requiredCapabilities: ['GENERAL_REASONING' as const],
    },
  };
  versions.push({
    definition: {
      id: 'w1-fixture-party',
      name: 'W1 队伍验收夹具',
      description: 'Test-only existing Party runtime fixture',
      category: 'TEST_ONLY',
      source: 'USER',
    },
    version: 1,
    entryStepId: party.id,
    steps: [party],
    edges: [],
    referenceBasis: [],
    createdAt,
  });
  for (const version of versions)
    if (
      !service
        .listVersions()
        .some((v) => v.definition.id === version.definition.id && v.version === version.version)
    )
      service.publish(version);
}
