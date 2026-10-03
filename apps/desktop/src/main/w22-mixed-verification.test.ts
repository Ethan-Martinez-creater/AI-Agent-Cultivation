import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowDetail } from '@cultivation/domain';
import {
  softwareManualVerificationFacts,
  softwareMixedVerificationBoundary,
} from './w22-mixed-verification.js';

function fixture() {
  const root = join(process.cwd(), '.test-data', `w22-mixed-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const manual = JSON.stringify({
    executions: [{ commandId: 'test', exitStatus: 0 }],
    criteria: [{ criterionId: 'AC-manual', status: 'PASS' }],
    failures: [],
  });
  writeFileSync(join(root, 'manual.json'), manual, 'utf8');
  const hash = createHash('sha256').update(manual).digest('hex');
  const step = {
    id: 's06',
    stepId: 'S06',
    workflowRunId: 'workflow',
    missionId: 'mission',
    missionRunId: 'run',
    state: 'WAITING',
    attempt: 1,
  };
  const version = {
    definition: { id: 'official.software-feature' },
    validationPolicy: 'software-integrity-v1',
    steps: [
      {
        id: 'S06',
        title: '验收',
        objective: '验收已批准的实现',
        routing: { requiredCapabilities: ['TOOL_USE'] },
        outputs: [{ key: 'software.tests', kind: 'JSON', required: true, maxSizeBytes: 1_000_000 }],
        workflowInputKeys: [],
      },
    ],
    contractManifest: [],
  };
  const criteria = [
    { id: 'AC-command', statement: '命令验收', verificationMethod: 'COMMAND', commandId: 'test' },
    { id: 'AC-manual', statement: '人工检查', verificationMethod: 'MANUAL' },
  ];
  const artifacts = [
    { id: 'acceptance', producerStepRunId: 's02', content: JSON.stringify({ criteria }) },
    {
      id: 'plan',
      producerStepRunId: 's03',
      content: JSON.stringify({
        commands: [{ id: 'test', command: 'node verify.mjs', required: true }],
      }),
    },
  ];
  const detail = {
    version,
    run: { id: 'workflow', inputSnapshot: { workspaceRoot: root } },
    steps: [step],
    artifacts,
    bindings: [
      { role: 'OUTPUT', key: 'software.acceptance', artifactId: 'acceptance' },
      { role: 'OUTPUT', key: 'software.plan_scope', artifactId: 'plan' },
    ],
  } as unknown as WorkflowDetail;
  const repository = {
    listRuns: () => [detail.run],
    detail: () => detail,
    findStepByMissionId: () => step,
  };
  const request = {
    id: 'request',
    state: 'ACCEPTED',
    missionId: 'mission',
    runId: 'run',
    assigneeTeammateId: 'bridge',
    submittedAt: 'at',
  };
  const artifact = {
    id: 'manual-artifact',
    path: 'manual.json',
    submittedAt: 'at',
    sizeBytes: Buffer.byteLength(manual),
    metadataJson: { targetArtifactId: 'software.tests', contentHash: hash },
  };
  const external = {
    getExternalWorkRequest: () => ({ request, artifacts: [artifact] }),
    listExternalWorkRequests: (_mission: string, run: string) =>
      request.runId === run ? [request] : [],
  };
  const fact = {
    id: 'call',
    workflowRunId: 'workflow',
    stepRunId: 's06',
    attempt: 1,
    missionId: 'mission',
    missionRunId: 'run',
    actorId: 'model',
    toolCallId: 'call',
    commandId: 'test',
    command: 'node verify.mjs',
    commandHash: createHash('sha256').update('node verify.mjs').digest('hex'),
    toolId: 'mcp:verify',
    exitStatus: 1,
    criterionIds: ['AC-command'],
    outputHash: 'a'.repeat(64),
  };
  const boundary = softwareMixedVerificationBoundary(
    repository as never,
    {
      listMissionEvents: () => [
        {
          runId: 'run',
          eventType: 'workflow.verification.manual_requested',
          payloadJson: { requestId: 'request', stepRunId: 's06' },
        },
      ],
    } as never,
    external as never,
    () => root,
    { listForStep: () => [fact] },
  );
  const continuation = { missionId: 'mission', runId: 'run', requestId: 'request' } as never;
  return { root, boundary, continuation, request, artifact, fact, repository, external, detail };
}

describe('Main mixed verification evidence composition', () => {
  it('requests manual coding inspection separately from the model TOOL_USE capability', () => {
    const h = fixture();
    expect(
      h.boundary.prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never),
    ).toMatchObject({ stepRunId: 's06', draft: { capability: 'CODING', title: '人工验收' } });
  });
  it('retains real command failure despite a Human Bridge command PASS claim and accepts only its manual criterion', async () => {
    const h = fixture();
    const merged = JSON.parse(await h.boundary.compose(h.continuation));
    expect(merged.executions[0]).toMatchObject({ toolExecutionId: 'call', exitStatus: 1 });
    expect(merged.criteria).toEqual([
      {
        criterionId: 'AC-command',
        status: 'FAIL',
        evidenceArtifactIds: ['call'],
        executionIds: ['call'],
      },
      {
        criterionId: 'AC-manual',
        status: 'PASS',
        evidenceArtifactIds: ['manual-artifact'],
        executionIds: [],
      },
    ]);
  });
  it('cannot borrow command facts from another Step/Run', async () => {
    const h = fixture();
    h.fact.missionRunId = 'other-run';
    const merged = JSON.parse(await h.boundary.compose(h.continuation));
    expect(merged.executions).toEqual([]);
    expect(merged.criteria[0].status).toBe('NOT_RUN');
  });
  it('checks accepted bytes again before completing the continuation', async () => {
    const h = fixture();
    writeFileSync(join(h.root, 'manual.json'), '{}', 'utf8');
    await expect(h.boundary.compose(h.continuation)).rejects.toThrow('已验收文件被修改');
  });
  it('requires the same accepted request and original MissionRun', async () => {
    const h = fixture();
    h.request.state = 'SUBMITTED';
    await expect(h.boundary.compose(h.continuation)).rejects.toThrow('人工验收来源无效');
    h.request.state = 'ACCEPTED';
    h.request.runId = 'another-run';
    await expect(h.boundary.compose(h.continuation)).rejects.toThrow('人工验收来源无效');
  });
  it('exposes only accepted manual artifacts to the deterministic policy', () => {
    const h = fixture();
    const list = softwareManualVerificationFacts(h.repository as never, h.external as never);
    expect(list('s06')).toMatchObject([
      { acceptedArtifactId: 'manual-artifact', criterionIds: ['AC-manual'] },
    ]);
    h.request.state = 'DENIED';
    expect(list('s06')).toEqual([]);
  });
});
