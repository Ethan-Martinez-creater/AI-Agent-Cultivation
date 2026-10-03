import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkflowArtifact, WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';
import {
  softwareWorkflowValidationPolicy,
  softwareToolScope,
  verifiedSoftwareFacts,
} from './w22-validation-policy.js';

function setup(exitStatus = 0, reportSource: WorkflowArtifact['source'] = 'MISSION') {
  const acceptedHash = 'b'.repeat(64);
  const artifact = (id: string, data: unknown) =>
    ({
      id,
      workflowRunId: 'workflow-run',
      content: JSON.stringify(data),
      producerStepRunId: 'verify',
      missionId: 'mission',
      missionRunId: 'mission-run',
      actorId: id === 'software.tests' && reportSource === 'HUMAN_BRIDGE' ? 'bridge' : 'actor',
      sourceId: id === 'software.tests' && reportSource === 'HUMAN_BRIDGE' ? 'manual-artifact' : id,
      source: id === 'software.tests' ? reportSource : 'MISSION',
      contentHash: acceptedHash,
      metadata:
        id === 'software.tests' && reportSource === 'HUMAN_BRIDGE'
          ? { contentHash: acceptedHash }
          : {},
    }) as WorkflowArtifact;
  const rows = [
    ['software.repo_context', { commands: [{ id: 'test', command: 'node verify.mjs' }] }],
    [
      'software.plan_scope',
      {
        files: [{ relativePath: 'src/main.ts', action: 'MODIFY' }],
        commands: [
          {
            id: 'test',
            command: 'node verify.mjs',
            required: true,
            acceptanceCriteriaIds: ['AC1'],
          },
        ],
      },
    ],
    [
      'software.acceptance',
      {
        criteria: [
          { id: 'AC1', severity: 'BLOCKING', verificationMethod: 'COMMAND', commandId: 'test' },
        ],
      },
    ],
    ['software.plan_review', { verdict: 'PASS', reviewedArtifactIds: ['software.plan_scope'] }],
    [
      'software.tests',
      {
        executions: [
          {
            commandId: 'test',
            command: 'node verify.mjs',
            toolId: 'mcp:verify',
            toolExecutionId: 'fact',
            exitStatus,
            acceptanceCriteriaIds: ['AC1'],
            outputArtifactId: 'fact',
            outputHash: 'a'.repeat(64),
          },
        ],
        criteria: [
          {
            criterionId: 'AC1',
            status: exitStatus === 0 ? 'PASS' : 'FAIL',
            executionIds: ['fact'],
            evidenceArtifactIds: ['fact'],
          },
        ],
        failures: [],
      },
    ],
    ['software.code_review', { verdict: 'PASS' }],
  ] as const;
  const detail = {
    version: { definition: { source: 'BUILTIN' }, validationPolicy: 'software-integrity-v1' },
    run: {
      id: 'workflow-run',
      inputSnapshot: { allowedToolScope: ['file.writeText'], targetArea: ['src'] },
    },
    steps: [
      {
        id: 'verify',
        workflowRunId: 'workflow-run',
        stepId: 'S06',
        attempt: 1,
        state: 'COMPLETED',
        missionId: 'mission',
        missionRunId: 'mission-run',
      },
    ],
    artifacts: rows.map(([id, value]) => artifact(id, value)),
    bindings: rows.map(([key]) => ({ key, role: 'OUTPUT', artifactId: key })),
  } as unknown as WorkflowDetail;
  const command = 'node verify.mjs';
  const facts = [
    {
      id: 'fact',
      workflowRunId: 'workflow-run',
      stepRunId: 'verify',
      attempt: 1,
      missionId: 'mission',
      missionRunId: 'mission-run',
      actorId: 'actor',
      toolCallId: 'tool-call',
      commandId: 'test',
      toolId: 'mcp:verify',
      command,
      commandHash: createHash('sha256').update(command, 'utf8').digest('hex'),
      exitStatus,
      criterionIds: ['AC1'],
      outputHash: 'a'.repeat(64),
    },
  ];
  const manualFacts: {
    requestId: string;
    missionId: string;
    missionRunId: string;
    assigneeId: string;
    criterionIds: string[];
    acceptedArtifactId: string;
    acceptedArtifactHash: string;
  }[] = [];
  const policy = softwareWorkflowValidationPolicy({
    listForStep: () => facts,
    listManualForStep: () => manualFacts,
  });
  const step = { id: 'decision', stepId: 'S07' } as WorkflowStepRun;
  return { detail, policy, step, facts, manualFacts, acceptedHash };
}

describe('software deterministic validation policy', () => {
  it('requires a same-Run/actor/call actual Tool result before a prepared verification row can affect PASS', () => {
    const fact = {
      missionId: 'm',
      missionRunId: 'run',
      actorId: 'actor',
      toolCallId: 'call',
      toolId: 'mcp:verify',
      outputHash: 'a'.repeat(64),
    };
    const events = [
      {
        missionId: 'm',
        runId: 'run',
        actorType: 'TEAMMATE',
        actorId: 'actor',
        eventType: 'tool.result',
        payloadJson: {
          success: true,
          source: 'MCP',
          toolCallId: 'call',
          toolId: 'mcp:verify',
          outputHash: 'a'.repeat(64),
        },
      },
    ];
    const verified = verifiedSoftwareFacts(
      { listVerificationFacts: () => [fact] } as never,
      { listMissionEvents: () => events } as never,
    );
    expect(verified.listForStep('step')).toEqual([fact]);
    events[0]!.runId = 'other-run';
    expect(verified.listForStep('step')).toEqual([]);
    events[0]!.runId = 'run';
    events[0]!.payloadJson.outputHash = 'b'.repeat(64);
    expect(verified.listForStep('step')).toEqual([]);
    events[0]!.payloadJson.outputHash = 'a'.repeat(64);
    events[0]!.actorId = 'other-actor';
    expect(verified.listForStep('step')).toEqual([]);
    events[0]!.actorId = 'actor';
    events[0]!.payloadJson.toolCallId = 'other-call';
    expect(verified.listForStep('step')).toEqual([]);
    events[0]!.payloadJson.toolCallId = 'call';
    events.length = 0;
    expect(verified.listForStep('step')).toEqual([]);
  });
  it('cannot pass vacuous verification without any acceptance criteria', () => {
    const { detail, policy, step } = setup();
    detail.artifacts.find((a) => a.id === 'software.acceptance')!.content = JSON.stringify({
      criteria: [],
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });
  it('cannot turn an unconfirmed command into an approved execution scope', () => {
    const { detail } = setup();
    detail.artifacts.find((a) => a.id === 'software.plan_scope')!.content = JSON.stringify({
      files: [],
      commands: [{ id: 'test', command: 'arbitrary-command', required: true }],
    });
    expect(softwareToolScope(detail).allowedCommands).toEqual([]);
  });
  it('rejects publishing actions even if a repository and plan claim to allow them', () => {
    const { detail, policy } = setup();
    detail.artifacts.find((a) => a.id === 'software.repo_context')!.content = JSON.stringify({
      commands: [{ id: 'push', command: 'git push origin main' }],
    });
    const plan = {
      files: [{ relativePath: 'src/main.ts', action: 'MODIFY', acceptanceCriteriaIds: ['AC1'] }],
      commands: [{ id: 'push', command: 'git push origin main', acceptanceCriteriaIds: ['AC1'] }],
    };
    expect(
      policy.validateStep(
        detail,
        { id: 'plan', stepId: 'S03' } as WorkflowStepRun,
        [
          { spec: { key: 'software.plan_scope' }, artifact: { content: JSON.stringify(plan) } },
        ] as never,
      ),
    ).toEqual(['PUBLISH_ACTION_FORBIDDEN']);
  });
  it('requires real required command success and linked acceptance evidence', () => {
    const { detail, policy, step } = setup();
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'PASS', waitForUser: false });
  });
  it('uses actual failure to enter REVISE rather than trusting a model success statement', () => {
    const { detail, policy, step } = setup(1);
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'REVISE', waitForUser: false });
  });
  it('fails closed when the reported exit status differs from the durable execution fact', () => {
    const { detail, policy, step, facts } = setup();
    facts[0]!.exitStatus = 1;
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });
  it('cannot claim success with missing required commands', () => {
    const { detail, policy, step } = setup();
    detail.artifacts.find((a) => a.id === 'software.tests')!.content = JSON.stringify({
      executions: [],
      criteria: [],
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });
  it('cannot treat unexecuted manual acceptance as model verified', () => {
    const { detail, policy, step } = setup();
    detail.artifacts.find((a) => a.id === 'software.acceptance')!.content = JSON.stringify({
      criteria: [{ id: 'AC1', severity: 'BLOCKING', verificationMethod: 'MANUAL' }],
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });
  it('keeps explicit independent review failure waiting rather than completing the run', () => {
    const { detail, policy, step } = setup();
    step.stepId = 'S09';
    detail.artifacts.find((a) => a.id === 'software.code_review')!.content = JSON.stringify({
      verdict: 'FAIL',
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'FAIL', waitForUser: true });
  });
  it('resolves confirmed commands and paths without granting permission', () => {
    const { detail } = setup();
    expect(softwareToolScope(detail)).toEqual({
      allowedToolIds: ['file.writeText'],
      allowedCommands: [{ id: 'test', command: 'node verify.mjs', acceptanceCriteriaIds: ['AC1'] }],
      acceptanceIds: ['AC1'],
      allowedPathPrefixes: ['src'],
      planFiles: ['src/main.ts'],
    });
  });
  it('excludes commands that did not appear in repository context', () => {
    const { detail } = setup();
    detail.artifacts.find((a) => a.id === 'software.repo_context')!.content = JSON.stringify({
      commands: [],
    });
    expect(softwareToolScope(detail).allowedCommands).toEqual([]);
  });

  it('A: rejects command claims in a Human Bridge report without the same actor-bound MCP fact', () => {
    const { detail, policy, step } = setup(0, 'HUMAN_BRIDGE');
    const report = detail.artifacts.find((item) => item.id === 'software.tests')!;
    expect(
      policy.validateStep!(
        detail,
        { id: 'verify', stepId: 'S06' } as WorkflowStepRun,
        [{ spec: { key: 'software.tests' }, artifact: report }] as never,
      ),
    ).toEqual(['VERIFICATION_PROVENANCE_INVALID']);
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });

  it('B: blocks a mixed report when manual criteria have no accepted continuation fact', () => {
    const { detail, policy, step } = setup();
    detail.artifacts.find((item) => item.id === 'software.acceptance')!.content = JSON.stringify({
      criteria: [
        { id: 'AC1', severity: 'BLOCKING', verificationMethod: 'COMMAND', commandId: 'test' },
        { id: 'AC2', severity: 'BLOCKING', verificationMethod: 'MANUAL' },
      ],
    });
    const report = detail.artifacts.find((item) => item.id === 'software.tests')!;
    const data = JSON.parse(report.content) as Record<string, unknown>;
    data.criteria = [
      {
        criterionId: 'AC1',
        status: 'PASS',
        executionIds: ['fact'],
        evidenceArtifactIds: ['fact'],
      },
      {
        criterionId: 'AC2',
        status: 'PASS',
        executionIds: [],
        evidenceArtifactIds: ['accepted-artifact'],
      },
    ];
    report.content = JSON.stringify(data);
    report.metadata = {
      manualRequestId: 'manual-request',
      manualArtifactId: 'accepted-artifact',
      manualContentHash: 'c'.repeat(64),
    };
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });

  it('C: passes a mixed MISSION report only when command facts and accepted manual evidence share the S06 MissionRun', () => {
    const { detail, policy, step, manualFacts } = setup();
    detail.artifacts.find((item) => item.id === 'software.acceptance')!.content = JSON.stringify({
      criteria: [
        { id: 'AC1', severity: 'BLOCKING', verificationMethod: 'COMMAND', commandId: 'test' },
        { id: 'AC2', severity: 'BLOCKING', verificationMethod: 'INSPECTION' },
      ],
    });
    const report = detail.artifacts.find((item) => item.id === 'software.tests')!;
    const data = JSON.parse(report.content) as Record<string, unknown>;
    data.criteria = [
      {
        criterionId: 'AC1',
        status: 'PASS',
        executionIds: ['fact'],
        evidenceArtifactIds: ['fact'],
      },
      {
        criterionId: 'AC2',
        status: 'PASS',
        executionIds: [],
        evidenceArtifactIds: ['accepted-artifact'],
      },
    ];
    report.content = JSON.stringify(data);
    report.metadata = {
      manualRequestId: 'manual-request',
      manualArtifactId: 'accepted-artifact',
      manualContentHash: 'c'.repeat(64),
    };
    manualFacts.push({
      requestId: 'manual-request',
      missionId: 'mission',
      missionRunId: 'mission-run',
      assigneeId: 'human-bridge',
      criterionIds: ['AC2'],
      acceptedArtifactId: 'accepted-artifact',
      acceptedArtifactHash: 'c'.repeat(64),
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'PASS', waitForUser: false });
  });

  it('D: blocks command facts bound to another workflow, step attempt, MissionRun, actor, or command hash', () => {
    const mismatches: Array<[string, unknown]> = [
      ['workflowRunId', 'other-workflow'],
      ['stepRunId', 'other-step'],
      ['attempt', 2],
      ['missionId', 'other-mission'],
      ['missionRunId', 'other-run'],
      ['actorId', 'other-actor'],
      ['toolCallId', ''],
      ['commandHash', 'f'.repeat(64)],
    ];
    for (const [key, value] of mismatches) {
      const { detail, policy, step, facts } = setup();
      Object.assign(facts[0]!, { [key]: value });
      expect(policy.decisionBranch!(detail, step)).toEqual({
        branch: 'BLOCKED',
        waitForUser: true,
      });
    }
  });

  it('E: accepts a pure Human Bridge manual report through its accepted artifact sourceId and hash', () => {
    const { detail, policy, step, manualFacts, acceptedHash } = setup(0, 'HUMAN_BRIDGE');
    detail.artifacts.find((item) => item.id === 'software.plan_scope')!.content = JSON.stringify({
      files: [],
      commands: [],
    });
    detail.artifacts.find((item) => item.id === 'software.acceptance')!.content = JSON.stringify({
      criteria: [{ id: 'AC2', severity: 'BLOCKING', verificationMethod: 'MANUAL' }],
    });
    const report = detail.artifacts.find((item) => item.id === 'software.tests')!;
    report.content = JSON.stringify({
      executions: [],
      criteria: [
        {
          criterionId: 'AC2',
          status: 'PASS',
          executionIds: [],
          evidenceArtifactIds: ['manual-artifact'],
        },
      ],
      failures: [],
    });
    manualFacts.push({
      requestId: 'manual-request',
      missionId: 'mission',
      missionRunId: 'mission-run',
      assigneeId: 'human-bridge',
      criterionIds: ['AC2'],
      acceptedArtifactId: 'manual-artifact',
      acceptedArtifactHash: acceptedHash,
    });
    expect(policy.decisionBranch!(detail, step)).toEqual({ branch: 'PASS', waitForUser: false });
  });
});
