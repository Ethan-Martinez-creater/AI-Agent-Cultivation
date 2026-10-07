import { describe, expect, it, vi } from 'vitest';
import { workflowHash } from '@cultivation/application';
import type { WorkflowRepository } from '@cultivation/application';
import type {
  CollaborationArtifact,
  Mission,
  MissionEvent,
  RuntimeProfile,
  Teammate,
  WorkflowDetail,
} from '@cultivation/domain';
import type { MissionRunRecord } from '@cultivation/application/gate3-mission-service';
import { memoryExecutionPreGateContext } from './r5-2-context.js';
import {
  makeMemoryPreGateRequest,
  MemoryPreGateService,
} from '@cultivation/application/r5-2-memory-pre-gate';

function fixture(workflow = false, party = false) {
  const mission = {
    id: 'mission',
    mode: party ? 'CONSULTATION' : 'SOLO',
    state: 'COMPLETED',
    coordinatorTeammateId: 'a',
    objective: 'Summarize analysis',
  } as Mission;
  const run = {
    id: 'run',
    missionId: mission.id,
    status: 'COMPLETED',
    resultText: 'PRIVATE_RESULT_BODY',
  } as MissionRunRecord;
  const teammate = {
    id: 'a',
    status: 'ACTIVE',
    executorKind: 'MODEL_RUNTIME',
    currentRuntimeProfileId: 'runtime',
  } as Teammate;
  const runtime = { id: 'runtime', executionProtocol: 'LANGUAGE' } as RuntimeProfile;
  const events = [
    {
      missionId: mission.id,
      runId: run.id,
      eventType: 'model.call_started',
      actorType: 'TEAMMATE',
      actorId: 'a',
      payloadJson: { runtimeProfileId: runtime.id, privatePrompt: 'PRIVATE_PROMPT_SENTINEL' },
    },
    {
      missionId: mission.id,
      runId: run.id,
      eventType: 'model.call_completed',
      actorType: 'TEAMMATE',
      actorId: 'a',
      payloadJson: {},
    },
  ] as MissionEvent[];
  const artifactContent = 'PRIVATE_ARTIFACT_BODY';
  const artifactMetadata = { outputKey: 'result' };
  const artifactHash = workflowHash({ content: artifactContent, metadata: artifactMetadata });
  const step = {
    id: 'step-run',
    stepId: 'task',
    state: 'COMPLETED',
    workflowRunId: 'workflow-run',
    missionId: mission.id,
    missionRunId: run.id,
    attempt: 1,
  };
  const detail = {
    run: {
      id: 'workflow-run',
      definitionId: 'definition',
      definitionVersion: 1,
      inputSnapshot: { secretInput: 'PRIVATE_INPUT_BODY' },
    },
    version: {
      definition: { id: 'definition' },
      version: 1,
      steps: [
        {
          id: 'task',
          type: 'TASK',
          objective: 'Analyze structured results',
          routing: { requiredCapabilities: ['GENERAL_REASONING'] },
          outputs: [{ key: 'result', kind: 'TEXT', contractId: 'analysis', contractVersion: '1' }],
        },
        { id: 'other', objective: 'PRIVATE_OTHER_STEP_HISTORY' },
      ],
    },
    steps: [step],
    artifacts: [
      {
        id: 'output',
        workflowRunId: 'workflow-run',
        producerStepRunId: step.id,
        missionId: mission.id,
        missionRunId: run.id,
        actorId: 'a',
        source: 'MISSION',
        kind: 'TEXT',
        content: artifactContent,
        metadata: artifactMetadata,
        contentHash: artifactHash,
      },
      {
        id: 'input',
        workflowRunId: 'workflow-run',
        kind: 'JSON',
        content: 'PRIVATE_INPUT_BODY',
        metadata: { path: 'C:\\private' },
      },
      {
        id: 'other-input',
        workflowRunId: 'workflow-run',
        kind: 'TEXT',
        content: 'PRIVATE_OTHER_STEP_HISTORY',
      },
    ],
    bindings: [
      {
        workflowRunId: 'workflow-run',
        stepRunId: step.id,
        role: 'OUTPUT',
        artifactId: 'output',
        key: 'result',
        contractId: 'analysis',
        contractVersion: '1',
      },
      {
        workflowRunId: 'workflow-run',
        stepRunId: step.id,
        role: 'INPUT',
        artifactId: 'input',
        key: 'analysis',
      },
      {
        workflowRunId: 'workflow-run',
        stepRunId: 'other-step',
        role: 'INPUT',
        artifactId: 'other-input',
        key: 'private',
      },
    ],
    validations: [
      {
        stepRunId: step.id,
        artifactId: 'output',
        valid: true,
        contentHash: artifactHash,
        contractId: 'analysis',
        contractVersion: '1',
      },
    ],
    events: [{ payloadJson: { fullHistory: 'PRIVATE_HISTORY_SENTINEL' } }],
  } as unknown as WorkflowDetail;
  const missionStore = {
    getMission: (id: string) => (id === mission.id ? mission : null),
    getRun: (id: string) => (id === run.id ? run : null),
    listMissionEvents: () => events,
  };
  const sources = {
    getTeammate: (id: string) => (id === teammate.id ? teammate : null),
    getRuntimeProfile: (id: string) => (id === runtime.id ? runtime : null),
    getModelBinding: () => ({
      teammateId: teammate.id,
      runtimeProfileId: runtime.id,
      providerKind: 'OPENAI' as const,
      endpoint: null,
      modelId: 'test-model',
      credentialId: null,
      verifiedAt: '2026-10-06',
      verificationSource: 'LIVE_TEST' as const,
      sealedAt: '2026-10-06',
      executionProtocol: 'LANGUAGE' as const,
    }),
    hasValidModelBinding: () => true,
    listCollaborationArtifacts: () =>
      [
        {
          id: 'member-result',
          missionId: mission.id,
          runId: run.id,
          teammateId: teammate.id,
          kind: 'MEMBER_RESULT',
          content: 'PRIVATE_MEMBER_RESULT',
        },
      ] as CollaborationArtifact[],
  };
  const workflows = {
    findStepByMissionId: () => (workflow ? step : null),
    detail: () => detail,
  } as unknown as Pick<WorkflowRepository, 'findStepByMissionId' | 'detail'>;
  const input = {
    missionId: mission.id,
    runId: run.id,
    ownerId: 'a',
    sourceId: workflow ? 'output' : party ? 'member-result' : run.id,
  };
  const context = () => memoryExecutionPreGateContext(missionStore, sources, workflows, input);
  return { context, mission, run, teammate, runtime, events, detail, input };
}

describe('R5.2 read-only execution provenance compatibility', () => {
  it('projects Free Mission source without body, history or control authority', async () => {
    const f = fixture();
    const context = f.context();
    expect(context).toMatchObject({
      ownerId: 'a',
      sourceType: 'MISSION_RESULT',
      sourceId: 'run',
      trigger: 'HARNESS',
    });
    const request = makeMemoryPreGateRequest(context);
    expect(JSON.stringify(request.state)).not.toMatch(/PRIVATE|runtime|Memory|Permission/);
    const evaluate = vi.fn(async () => ({
      answers: { extraction: 'RUN_EXTRACTION' },
      confidence: { extraction: 1 },
      selectedAction: null,
    }));
    await new MemoryPreGateService(async () => ({ evaluate })).evaluate(context);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // Adapter has no extraction/write ports: evaluating never writes Memory or changes Mission.
    expect(f.mission.state).toBe('COMPLETED');
  });
  it('projects only the frozen current Workflow Step and exact input metadata', () => {
    const f = fixture(true);
    const context = f.context();
    expect(context.sourceType).toBe('WORKFLOW_STEP_RESULT');
    expect(context.execution).toMatchObject({
      stepType: 'TASK',
      objectiveSummary: 'Analyze structured results',
      inputArtifactSummaries: [{ id: 'input', kind: 'JSON', name: 'analysis' }],
    });
    expect(JSON.stringify(makeMemoryPreGateRequest(context).state)).not.toMatch(
      /PRIVATE|C:|other-input|inputSnapshot|events|history|content/,
    );
  });
  it('Party source belongs to the actual participant, never another actor or just membership', () => {
    const f = fixture(false, true);
    expect(f.context()).toMatchObject({ ownerId: 'a', sourceId: 'member-result' });
    f.input.ownerId = 'b';
    expect(f.context).toThrow();
  });
  it.each(['run', 'actor', 'runtime', 'unfinished', 'source', 'bridge', 'generation'])(
    'rejects forged or unavailable %s facts',
    (kind) => {
      const f = fixture();
      if (kind === 'run') f.input.runId = 'other-run';
      if (kind === 'actor')
        f.events.forEach((event) => {
          event.actorId = 'b';
        });
      if (kind === 'runtime') f.events[0]!.payloadJson.runtimeProfileId = 'different';
      if (kind === 'unfinished') f.run.status = 'RUNNING';
      if (kind === 'source') f.input.sourceId = 'forged';
      if (kind === 'bridge') f.teammate.executorKind = 'USER_BRIDGE';
      if (kind === 'generation') f.runtime.executionProtocol = 'GENERATION';
      expect(f.context).toThrow();
    },
  );
  it.each([
    'hash',
    'metadata',
    'owner',
    'receipt',
    'binding',
    'version',
    'attempt',
    'missionRun',
    'unfinished',
  ])('rejects invalid Workflow %s provenance', (kind) => {
    const f = fixture(true);
    if (kind === 'hash') f.detail.artifacts[0]!.contentHash = 'f'.repeat(64);
    if (kind === 'metadata') f.detail.artifacts[0]!.metadata.outputKey = 'tampered';
    if (kind === 'owner') f.detail.artifacts[0]!.actorId = 'b';
    if (kind === 'receipt') f.detail.validations[0]!.valid = false;
    if (kind === 'binding') f.detail.bindings[0]!.contractId = 'forged';
    if (kind === 'version') f.detail.run.definitionVersion = 2;
    if (kind === 'attempt')
      f.detail.steps.push({ ...f.detail.steps[0]!, id: 'new-attempt', attempt: 2 });
    if (kind === 'missionRun') f.detail.steps[0]!.missionRunId = 'different';
    if (kind === 'unfinished') f.detail.steps[0]!.state = 'RUNNING';
    expect(f.context).toThrow();
  });
});
