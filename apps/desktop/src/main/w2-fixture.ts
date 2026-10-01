import { WorkflowFixtureGateway } from './w1-fixture.js';
import { BuiltinWorkflowRegistry } from '@cultivation/application';
import type { ModelRequest, ModelToolResponse } from '@cultivation/application';
import type {
  ArtifactContract,
  WorkflowArtifactSpec,
  WorkflowStepDefinition,
  WorkflowVersion,
} from '@cultivation/domain';
import type { W1WorkflowRepository, W2WorkflowRepository } from '@cultivation/persistence';

/** Shared package smoke fixture; never installed by production bootstrap. */
export class ContractFixtureGateway extends WorkflowFixtureGateway {
  private reviewCalls = 0;
  override async generate(request: ModelRequest) {
    const original = await super.generate(request);
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    if (prompt.startsWith('__W2_REVIEW')) {
      const report = request.messages.find(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('Workflow input artifact report'),
      );
      const ids =
        typeof report?.content === 'string'
          ? [...report.content.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!)
          : [];
      this.reviewCalls += 1;
      return {
        ...original,
        text: JSON.stringify({
          verdict: prompt.startsWith('__W2_REVIEW_PASS') ? 'PASS' : 'REVISE',
          findings: [],
          evidence: [],
          summary: 'Declared test-only review',
          reviewedArtifactIds: ids,
          ...(prompt.startsWith('__W2_REVIEW_PASS')
            ? {}
            : { revisionCode: this.reviewCalls % 2 === 0 ? 'fix.second' : 'fix.first' }),
        }),
      };
    }
    if (prompt.startsWith('__W2_')) return { ...original, text: '{"ok":true}' };
    return original;
  }
  override async generateWithTools(
    request: Parameters<NonNullable<WorkflowFixtureGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const prompt = request.messages.find((m) => m.role === 'user')?.content;
    if (
      typeof prompt === 'string' &&
      prompt.startsWith('__W2_FILE') &&
      !request.messages.some((m) => m.role === 'tool')
    )
      return {
        text: '',
        usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null },
        toolCalls: [
          {
            id: 'w2-file-call',
            toolId: 'file.writeText',
            input: { path: 'w2-output.txt', content: 'W2 permission-gated atomic file output' },
          },
        ],
      };
    return super.generateWithTools(request);
  }
}
const jsonContract: ArtifactContract = {
  contractId: 'test.w2.json',
  contractVersion: '1',
  kind: 'JSON',
  validatorVersion: 'w2-deterministic-v1',
  maxSizeBytes: 16_384,
  validator: {
    type: 'JSON_SCHEMA',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
};
const jsonOutput: WorkflowArtifactSpec = {
  key: 'result',
  kind: 'JSON',
  required: true,
  contractId: jsonContract.contractId,
  contractVersion: '1',
  maxSizeBytes: jsonContract.maxSizeBytes,
  description: 'Test-only JSON contract',
  validator: { type: 'REGISTRY', contractId: jsonContract.contractId, contractVersion: '1' },
};
function step(id: string, objective: string): WorkflowStepDefinition {
  return {
    id,
    title: id,
    objective,
    type: 'TASK',
    routing: { executionConstraint: 'SOLO', requiredCapabilities: ['GENERAL_REASONING'] },
    inputs: [],
    outputs: [jsonOutput],
    maxAttempts: 5,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
  };
}
function version(
  id: string,
  steps: WorkflowStepDefinition[],
  contracts = [jsonContract],
): WorkflowVersion {
  const final = steps.at(-1)!;
  return {
    definition: {
      id,
      name: id,
      description: 'W2.0 test-only foundation package; not an official template',
      category: 'TEST_ONLY',
      source: 'USER',
    },
    version: 1,
    entryStepId: steps[0]!.id,
    steps,
    edges: [],
    contractManifest: contracts,
    outputSchema: {
      outputs: final.outputs.map((output) => ({
        ...output,
        fromStepId: final.id,
        outputKey: output.key,
      })),
    },
    referenceBasis: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}
export function registerContractFixtures(
  store: W1WorkflowRepository,
  foundation: W2WorkflowRepository,
): void {
  const fixtures: WorkflowVersion[] = [
    version('w2-fixture-contract', [step('task', '__W2_JSON__')]),
  ];
  const file: ArtifactContract = {
    contractId: 'test.w2.file',
    contractVersion: '1',
    kind: 'FILE',
    validatorVersion: 'w2-deterministic-v1',
    maxSizeBytes: 16_384,
    validator: {
      type: 'FILE_METADATA',
      allowedExtensions: ['.txt'],
      allowedMediaTypes: [],
      requireContentHash: true,
    },
  };
  fixtures.push(
    version(
      'w2-fixture-file',
      [
        {
          ...step('file', '__W2_FILE__'),
          effectType: 'FILE_OUTPUT',
          effectPaths: ['w2-output.txt'],
          outputs: [
            {
              ...jsonOutput,
              key: 'w2-output.txt',
              kind: 'FILE',
              contractId: file.contractId,
              validator: { type: 'REGISTRY', contractId: file.contractId, contractVersion: '1' },
            },
          ],
        },
      ],
      [file],
    ),
  );
  const workspaceContract: ArtifactContract = {
    contractId: 'test.w2.workspace',
    contractVersion: '1',
    kind: 'WORKSPACE',
    validatorVersion: 'w2-deterministic-v1',
    maxSizeBytes: 16_384,
    validator: {
      type: 'WORKSPACE_MANIFEST',
      maxEntries: 4,
      allowedPaths: ['w2-output.txt'],
      requireBeforeHash: true,
    },
  };
  fixtures.push(
    version(
      'w2-fixture-workspace',
      [
        {
          ...step('mutation', '__W2_FILE__'),
          effectType: 'WORKSPACE_MUTATION',
          effectPaths: ['w2-output.txt'],
          outputs: [
            {
              ...jsonOutput,
              key: 'workspace',
              kind: 'DIRECTORY',
              contractId: workspaceContract.contractId,
              validator: {
                type: 'REGISTRY',
                contractId: workspaceContract.contractId,
                contractVersion: '1',
              },
            },
          ],
        },
      ],
      [workspaceContract],
    ),
  );
  fixtures.push(
    version('w2-fixture-external', [
      { ...step('external', '__W2_EXTERNAL__'), effectType: 'EXTERNAL_ACTION' },
    ]),
  );
  const reviewContract: ArtifactContract = {
    ...jsonContract,
    contractId: 'test.w2.review',
    validator: {
      type: 'JSON_SCHEMA',
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'enum', values: ['PASS', 'REVISE', 'FAIL'] },
          findings: {
            type: 'array',
            minItems: 0,
            maxItems: 20,
            items: { type: 'string', minLength: 0, maxLength: 1000 },
          },
          evidence: {
            type: 'array',
            minItems: 0,
            maxItems: 20,
            items: { type: 'string', minLength: 0, maxLength: 1000 },
          },
          summary: { type: 'string', minLength: 0, maxLength: 2000 },
          reviewedArtifactIds: {
            type: 'array',
            minItems: 0,
            maxItems: 12,
            items: { type: 'string', minLength: 0, maxLength: 128 },
          },
          revisionCode: { type: 'enum', values: ['fix.first', 'fix.second'] },
        },
        required: ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'],
      },
    },
  };
  const revision = version(
    'w2-fixture-revision',
    [
      step('draft', '__W2_JSON__'),
      {
        ...step('review', '__W2_REVIEW__'),
        type: 'REVIEW',
        inputs: [{ key: 'draft', fromStepId: 'draft', outputKey: 'result', required: true }],
        outputs: [
          {
            ...jsonOutput,
            contractId: reviewContract.contractId,
            validator: {
              type: 'REGISTRY',
              contractId: reviewContract.contractId,
              contractVersion: '1',
            },
          },
        ],
      },
    ],
    [jsonContract, reviewContract],
  );
  revision.revisionGroups = [
    { id: 'test.shared', maxTotalTraversals: 2, onExhausted: 'WAITING_USER' },
  ];
  revision.edges = [
    {
      id: 'draft-review',
      fromStepId: 'draft',
      toStepId: 'review',
      branch: 'NEXT',
      condition: { type: 'ALWAYS' },
    },
    {
      id: 'fix-first',
      fromStepId: 'review',
      toStepId: 'draft',
      branch: 'FIX_FIRST',
      condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
      revisionCode: 'fix.first',
      revision: { groupId: 'test.shared', maxTraversals: 2 },
    },
    {
      id: 'fix-second',
      fromStepId: 'review',
      toStepId: 'draft',
      branch: 'FIX_SECOND',
      condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
      revisionCode: 'fix.second',
      revision: { groupId: 'test.shared', maxTraversals: 2 },
    },
    {
      id: 'review-pass',
      fromStepId: 'review',
      toStepId: null,
      branch: 'PASS',
      condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
    },
  ];
  fixtures.push(revision);
  for (const fixture of fixtures)
    store.transaction(() => {
      for (const contract of fixture.contractManifest ?? []) foundation.registerContract(contract);
      store.publishVersion(fixture);
    });
  const builtin = version('test-only-builtin-contract', [step('task', '__W2_JSON__')]);
  builtin.definition.source = 'BUILTIN';
  builtin.releaseMetadata = {
    referenceBasis: [
      {
        title: 'AP-007 deterministic foundation fixture',
        organizationOrCommunity: 'Project',
        referenceType: 'STANDARD_OR_GUIDE',
        uri: 'docs/AI-Agent-Cultivation_AP-007_Official_Builtin_Workflows_Plan_v1.1.md',
        retrievedAt: builtin.createdAt,
        adoptedPrinciples: ['Immutable contracts; bounded declared transitions'],
        intentionallyExcludedMechanisms: ['Vendor agent graph and automatic replay'],
        rationale: 'Exercise project-native W1/R4 authority using a test-only package',
      },
    ],
    contractManifest: [{ contractId: jsonContract.contractId, contractVersion: '1' }],
    revisionManifest: { groups: [], edges: [] },
    effectManifest: [{ stepId: 'task', effectType: 'NONE', paths: [] }],
    designRationale:
      'Test-only release validator and immutable registration; no official template.',
  };
  const released = new BuiltinWorkflowRegistry({ testOnly: true }).register({
    testOnly: true,
    version: builtin,
  });
  store.transaction(() => {
    foundation.registerRelease({
      definitionId: released.definition.id,
      version: released.version,
      manifestHash: released.releaseMetadata!.manifestHash!,
      releasedAt: released.createdAt,
    });
    store.publishVersion(released);
  });
}
