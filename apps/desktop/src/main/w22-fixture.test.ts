import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelToolCall } from '@cultivation/application';
import { validateArtifactContract } from '@cultivation/domain';
import type {
  ToolDescriptor,
  WorkflowArtifact,
  WorkflowArtifactBinding,
  WorkflowDetail,
  WorkflowStepRun,
} from '@cultivation/domain';
import {
  SOFTWARE_FEATURE_CONTRACTS,
  SOFTWARE_FEATURE_VERSION_1,
} from '../../../../packages/application/src/builtin/software-feature/v1.js';
import { SoftwareWorkflowFixtureGateway } from './w22-fixture.js';

const createdAt = '2026-10-03T00:00:00.000Z';
const runId = 'fixture-software-run';
const version = SOFTWARE_FEATURE_VERSION_1;

function artifact(id: string, outputKey: string, content: unknown): WorkflowArtifact {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    id,
    workflowRunId: runId,
    producerStepRunId: `producer-${id}`,
    missionId: `mission-${id}`,
    missionRunId: `mission-run-${id}`,
    actorId: 'fixture-implementer',
    sourceId: `source-${id}`,
    source: 'MISSION',
    kind: outputKey === 'software.spec' || outputKey === 'software.plan' ? 'TEXT' : 'JSON',
    content: serialized,
    contentHash: `hash-${id}`,
    metadata: { outputKey, logicalKey: outputKey },
    inputArtifactIds: [],
    createdAt,
  };
}

function validateOutput(contractId: string, kind: 'TEXT' | 'JSON', content: string): string[] {
  const contract = SOFTWARE_FEATURE_CONTRACTS.find(
    (candidate) => candidate.contractId === contractId,
  );
  if (!contract) throw new Error(`Missing official contract ${contractId}`);
  return validateArtifactContract(contract, { kind, content });
}

function makeContext(
  stepId: string,
  objective: string,
  options: {
    attempt?: number;
    planFiles?: Array<Record<string, unknown>>;
    includePlan?: boolean;
  } = {},
): { detail: WorkflowDetail; step: WorkflowStepRun } {
  const step = {
    id: `step-run-${stepId}-${options.attempt ?? 1}`,
    workflowRunId: runId,
    stepId,
    attempt: options.attempt ?? 1,
    state: 'RUNNING',
    missionId: `mission-${stepId}`,
    missionRunId: `mission-run-${stepId}`,
    waitReason: null,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  } as WorkflowStepRun;
  const artifacts: WorkflowArtifact[] = [];
  const bindings: WorkflowArtifactBinding[] = [];
  const addInput = (key: string, outputKey: string, content: unknown) => {
    const created = artifact(`artifact-${stepId}-${key}`, outputKey, content);
    artifacts.push(created);
    bindings.push({
      id: `binding-${stepId}-${key}`,
      workflowRunId: runId,
      stepRunId: step.id,
      key,
      artifactId: created.id,
      role: 'INPUT',
      contractId: `fixture.${outputKey}`,
      contractVersion: '1',
      createdAt,
    });
  };
  const casePlanFiles =
    objective.toLowerCase().includes('migration') || objective.includes('迁移')
      ? [
          {
            relativePath: 'migrations/0001_feature.sql',
            action: 'CREATE',
            acceptanceCriteriaIds: ['AC-MIGRATION'],
          },
        ]
      : /case[-_ ]?c|cross[-_ ]?layer|renderer.{0,20}ipc/i.test(objective)
        ? [
            { relativePath: 'renderer.ts', action: 'MODIFY', acceptanceCriteriaIds: ['AC-UI'] },
            { relativePath: 'ipc.ts', action: 'MODIFY', acceptanceCriteriaIds: ['AC-IPC'] },
            {
              relativePath: 'store.ts',
              action: 'MODIFY',
              acceptanceCriteriaIds: ['AC-PERSISTENCE'],
            },
          ]
        : [{ relativePath: 'main.js', action: 'MODIFY', acceptanceCriteriaIds: ['AC-BUGFIX'] }];
  if (['S05', 'S10'].includes(stepId) && options.includePlan !== false) {
    addInput('plan_scope', 'software.plan_scope', {
      files: options.planFiles ?? casePlanFiles,
      commands: [
        {
          id: 'verify-feature',
          command: 'node verify.mjs',
          acceptanceCriteriaIds: ['AC-BUGFIX'],
          required: true,
        },
      ],
      migrationImpact: 'None.',
      securityImpact: 'ToolRuntime permissions required.',
      rollback: 'Restore before-hash.',
    });
  }
  if (stepId === 'S06') {
    addInput('repository_context', 'software.repo_context', {
      summary: 'Bounded fixture repository context.',
      modules: [],
      changeSurface: ['main.js'],
      tests: [{ name: 'test', path: 'package.json', status: 'PRESENT' }],
      commands: [{ id: 'verify-feature', command: 'node verify.mjs', sourcePath: 'package.json' }],
      risks: [],
      unknowns: [],
    });
    addInput('plan_scope', 'software.plan_scope', {
      files: casePlanFiles,
      commands: [
        {
          id: 'verify-feature',
          command: 'node verify.mjs',
          acceptanceCriteriaIds: ['AC-BUGFIX'],
          required: true,
        },
      ],
    });
    addInput('acceptance', 'software.acceptance', {
      criteria: [
        {
          id: 'AC-BUGFIX',
          statement: 'Bugfix is observed.',
          verificationMethod: 'COMMAND',
          commandId: 'verify-feature',
          severity: 'BLOCKING',
        },
      ],
    });
  }
  if (stepId === 'S04' || stepId === 'S08')
    addInput('reviewed', 'software.review-input', { summary: 'Review evidence.' });
  const detail = {
    run: {
      id: runId,
      definitionId: version.definition.id,
      definitionVersion: version.version,
      inputSnapshot: { objective, workspaceRoot: 'fixture-workspace' },
      state: 'RUNNING',
      waitReason: null,
      createdAt,
      updatedAt: createdAt,
    },
    version,
    steps: [step],
    artifacts,
    bindings,
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
  } as unknown as WorkflowDetail;
  return { detail, step };
}

const tool = (id: string, source: ToolDescriptor['source'], name = id): ToolDescriptor =>
  ({
    id,
    source,
    name,
    description: 'Offline fixture Tool',
    inputSchema: { type: 'object' },
    riskLevel: 'READ_ONLY',
    sideEffect: 'NONE',
    capability: source === 'MCP' ? 'MCP_TOOL_EXECUTE' : 'FILE_READ',
  }) as ToolDescriptor;

function request(tools: ToolDescriptor[] = []): ModelRequest & { tools: ToolDescriptor[] } {
  return {
    runtimeProfileId: 'fixture-runtime',
    teammateId: 'fixture-reviewer',
    messages: [{ role: 'user', content: 'Continue the W2.2 offline acceptance workflow.' }],
    tools,
  };
}

function transcript(call: ModelToolCall, value: unknown, ok = true) {
  return [
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.toolId,
          input: call.input,
        },
      ],
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: call.id,
          toolName: call.toolId,
          output: {
            type: 'json' as const,
            value: {
              classification: 'UNTRUSTED_EXTERNAL_DATA' as const,
              toolId: call.toolId,
              ok,
              code: ok ? null : 'FIXTURE_FAILED',
              content: JSON.stringify(value),
            },
          },
        },
      ],
    },
  ];
}

describe('SoftwareWorkflowFixtureGateway', () => {
  it('reads repository context through the declared file Tool and then emits S01 facts', async () => {
    const context = makeContext('S01', 'W22 CASE A: small bugfix');
    const gateway = new SoftwareWorkflowFixtureGateway(() => context);
    const initial = request([tool('file.readText', 'BUILTIN')]);
    const proposal = await gateway.generateWithTools(initial);
    expect(proposal.toolCalls).toHaveLength(1);
    expect(proposal.toolCalls[0]).toMatchObject({
      toolId: 'file.readText',
      input: { path: 'package.json' },
    });

    const resumed = {
      ...initial,
      messages: [
        ...initial.messages,
        ...transcript(proposal.toolCalls[0]!, {
          scripts: { test: 'node verify.mjs' },
        }),
      ],
    };
    const completed = await gateway.generateWithTools(resumed);
    expect(completed.toolCalls).toEqual([]);
    expect(JSON.parse(completed.text)).toMatchObject({
      summary: expect.stringContaining('ToolRuntime'),
      commands: [{ id: 'verify-feature', command: 'node verify.mjs', sourcePath: 'package.json' }],
    });
    expect(validateOutput('software.repo_context', 'JSON', completed.text)).toEqual([]);
  });

  it.each([
    ['W22 CASE A: small bugfix', ['main.js']],
    ['W22 CASE B: migration', ['migrations/0001_feature.sql']],
    ['W22 CASE C: cross-layer renderer IPC persistence', ['renderer.ts', 'ipc.ts', 'store.ts']],
  ])(
    'keeps implementation Tool writes inside the accepted plan for %s',
    async (objective, paths) => {
      const context = makeContext('S05', objective);
      const gateway = new SoftwareWorkflowFixtureGateway(() => context);
      const writeTool = tool('file.writeText', 'BUILTIN');
      let resumed = request([writeTool]);
      for (const path of paths) {
        const proposal = await gateway.generateWithTools(resumed);
        expect(proposal.toolCalls[0]).toMatchObject({ toolId: 'file.writeText', input: { path } });
        resumed = {
          ...resumed,
          messages: [
            ...resumed.messages,
            ...transcript(proposal.toolCalls[0]!, { path, bytes: 64 }),
          ],
        };
      }
      const completed = await gateway.generateWithTools(resumed);
      expect(completed.toolCalls).toEqual([]);
      expect(completed.text).toBe('{"ok":true}');
    },
  );

  it('requests only the fixed verifier command from the selected MCP Tool', async () => {
    const context = makeContext('S06', 'W22 CASE A: small bugfix');
    const verifier = tool('mcp:software-fixture:verify_repository', 'MCP', 'verify_repository');
    const gateway = new SoftwareWorkflowFixtureGateway(() => context);
    const proposal = await gateway.generateWithTools(request([verifier]));
    expect(proposal.toolCalls[0]).toMatchObject({
      toolId: verifier.id,
      input: {
        commandId: 'verify-feature',
        command: 'node verify.mjs',
        acceptanceCriterionIds: ['AC-BUGFIX'],
      },
    });
  });

  it.each([
    ['S05', 1, 'export const answer = 41;\n'],
    ['S10', 1, 'export const answer = 42;\n'],
    ['S10', 2, 'export const answer = 42; // reviewed\n'],
  ] as const)(
    'uses the expected repair state for %s attempt %s',
    async (stepId, attempt, content) => {
      const context = makeContext(stepId, 'W22 CASE A: small bugfix', { attempt });
      const gateway = new SoftwareWorkflowFixtureGateway(() => context);
      const proposal = await gateway.generateWithTools(
        request([tool('file.writeText', 'BUILTIN')]),
      );
      expect(proposal.toolCalls[0]?.input).toMatchObject({ path: 'main.js', content });
    },
  );

  it('includes verifier result provenance and maps exit failure to criteria without model judgment', async () => {
    const context = makeContext('S06', 'W22 CASE A: small bugfix');
    const verifier = tool('mcp:software-fixture:verify_repository', 'MCP', 'verify_repository');
    const gateway = new SoftwareWorkflowFixtureGateway(() => context);
    const initial = request([verifier]);
    const call = (await gateway.generateWithTools(initial)).toolCalls[0]!;
    const content = {
      structuredContent: {
        workflowEvidence: {
          verification: {
            commandId: 'verify-feature',
            command: 'node verify.mjs',
            exitStatus: 1,
            failure: 'ASSERTION_FAILED',
            acceptanceCriterionIds: ['AC-BUGFIX'],
            outputHash: 'sha256-verifier-output',
          },
        },
      },
    };
    const resumed = {
      ...initial,
      messages: [...initial.messages, ...transcript(call, content)],
    };
    const completed = await gateway.generateWithTools(resumed);
    const encodedToolResult = JSON.stringify(content);
    const outputHash = createHash('sha256').update(encodedToolResult).digest('hex');
    expect(JSON.parse(completed.text)).toEqual({
      executions: [
        {
          commandId: 'verify-feature',
          command: 'node verify.mjs',
          toolId: verifier.id,
          toolExecutionId: call.id,
          exitStatus: 1,
          acceptanceCriteriaIds: ['AC-BUGFIX'],
          outputArtifactId: call.id,
          outputHash,
        },
      ],
      criteria: [
        {
          criterionId: 'AC-BUGFIX',
          status: 'FAIL',
          evidenceArtifactIds: [call.id],
          executionIds: [call.id],
        },
      ],
      failures: [
        { executionId: call.id, criterionIds: ['AC-BUGFIX'], summary: 'ASSERTION_FAILED' },
      ],
    });
    expect(validateOutput('software.tests', 'JSON', completed.text)).toEqual([]);
  });

  it('produces a first plan revision and later passes the reviewed artifact lineage', async () => {
    const first = makeContext('S04', 'W22 CASE A: small bugfix', { attempt: 1 });
    const gateway = new SoftwareWorkflowFixtureGateway(() => first);
    const initial = await gateway.generate(request());
    expect(JSON.parse(initial.text)).toMatchObject({
      verdict: 'REVISE',
      reviewedArtifactIds: ['artifact-S04-reviewed'],
    });
    expect(validateOutput('software.review', 'JSON', initial.text)).toEqual([]);

    const second = makeContext('S04', 'W22 CASE A: small bugfix', { attempt: 2 });
    const recovered = new SoftwareWorkflowFixtureGateway(() => second);
    expect(JSON.parse((await recovered.generate(request())).text)).toMatchObject({
      verdict: 'PASS',
    });
  });

  it('produces one bounded code review finding, then a passing review on the next attempt', async () => {
    const first = makeContext('S08', 'W22 CASE A: small bugfix', { attempt: 1 });
    const gateway = new SoftwareWorkflowFixtureGateway(() => first);
    expect(JSON.parse((await gateway.generate(request())).text)).toMatchObject({
      verdict: 'REVISE',
    });
    expect(
      validateOutput('software.review', 'JSON', (await gateway.generate(request())).text),
    ).toEqual([]);
    const second = makeContext('S08', 'W22 CASE A: small bugfix', { attempt: 2 });
    expect(
      JSON.parse((await new SoftwareWorkflowFixtureGateway(() => second).generate(request())).text),
    ).toMatchObject({ verdict: 'PASS' });
  });

  it('emits S02 and S03 text artifacts with every frozen contract section', async () => {
    const specification = await new SoftwareWorkflowFixtureGateway(() =>
      makeContext('S02', 'W22 CASE A: small bugfix'),
    ).generate(request());
    const specOutput = JSON.parse(specification.text).outputs['software.spec'] as string;
    for (const heading of ['Requirements', 'Acceptance Criteria', 'Constraints', 'Out of Scope'])
      expect(specOutput).toContain(`# ${heading}`);
    expect(validateOutput('software.spec', 'TEXT', specOutput)).toEqual([]);
    expect(
      validateOutput(
        'software.acceptance',
        'JSON',
        JSON.stringify(JSON.parse(specification.text).outputs['software.acceptance']),
      ),
    ).toEqual([]);

    const plan = await new SoftwareWorkflowFixtureGateway(() =>
      makeContext('S03', 'W22 CASE A: small bugfix'),
    ).generate(request());
    const planOutput = JSON.parse(plan.text).outputs['software.plan'] as string;
    for (const heading of [
      'Files and Modules',
      'Ordered Steps',
      'Test Strategy',
      'Migration Impact',
      'Security and Permission Impact',
      'Rollback Considerations',
    ])
      expect(planOutput).toContain(`# ${heading}`);
    expect(validateOutput('software.plan', 'TEXT', planOutput)).toEqual([]);
    expect(
      validateOutput(
        'software.plan_scope',
        'JSON',
        JSON.stringify(JSON.parse(plan.text).outputs['software.plan_scope']),
      ),
    ).toEqual([]);
  });

  it('matches the frozen software.fix and software.delivery output contracts', async () => {
    const fix = await new SoftwareWorkflowFixtureGateway(() =>
      makeContext('S10', 'W22 CASE A: small bugfix'),
    ).generate(request());
    const fixOutput = JSON.parse(fix.text).outputs['software.fix_summary'];
    expect(fixOutput).toMatchObject({
      summary: expect.any(String),
      changedPaths: ['main.js'],
      fixes: [
        {
          criterionId: 'AC-BUGFIX',
          summary: expect.any(String),
          verificationCommandIds: ['verify-feature'],
        },
      ],
    });
    expect(fixOutput.addressedFindingIds).toBeUndefined();
    expect(validateOutput('software.fix', 'JSON', JSON.stringify(fixOutput))).toEqual([]);

    const delivery = await new SoftwareWorkflowFixtureGateway(() =>
      makeContext('S11', 'W22 CASE A: small bugfix'),
    ).generate(request());
    const deliveryOutput = JSON.parse(delivery.text).outputs['software.delivery'] as string;
    for (const heading of [
      'What Changed',
      'Files and Modules',
      'Verification',
      'Known Limitations',
      'Remaining Risks',
      'Manual Verification',
    ])
      expect(deliveryOutput).toContain(`# ${heading}`);
    expect(validateOutput('software.delivery', 'TEXT', deliveryOutput)).toEqual([]);
  });
});
