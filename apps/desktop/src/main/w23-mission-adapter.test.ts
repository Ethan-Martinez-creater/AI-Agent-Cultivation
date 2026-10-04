import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowDetail, WorkflowStepDefinition, WorkflowStepRun } from '@cultivation/domain';
import { WorkflowMissionAdapter } from './w1-mission-adapter.js';

function fixture(mode = 'COMPUTATIONAL', reviewers = ['author', 'reviewer']) {
  const authorStep = {
    id: 'author-step',
    stepId: 'R05',
    state: 'COMPLETED',
    missionId: 'author-mission',
    missionRunId: 'author-run',
  };
  const definition = {
    id: 'R06',
    executionRequirements: { independentReviewOfStepIds: ['R05'] },
    routing: { requiredCapabilities: ['GENERAL_REASONING'] },
  } as WorkflowStepDefinition;
  const step = { id: 'review-step', stepId: 'R06', workflowRunId: 'workflow' } as WorkflowStepRun;
  const detail = {
    run: {
      id: 'workflow',
      definitionId: 'official.research',
      definitionVersion: 1,
      inputSnapshot: { experimentMode: mode },
    },
    version: {
      definition: { id: 'official.research', source: 'BUILTIN' },
      version: 1,
      validationPolicy: 'research-integrity-v1',
      steps: [definition],
    },
    steps: [authorStep, step],
  } as unknown as WorkflowDetail;
  const events = [
    {
      runId: 'author-run',
      actorType: 'TEAMMATE',
      actorId: 'member',
      eventType: 'model.call_started',
    },
    {
      runId: 'old-run',
      actorType: 'TEAMMATE',
      actorId: 'unexecuted-target',
      eventType: 'collaboration.denied',
    },
  ];
  const store = {
    getMission: () => ({ coordinatorTeammateId: 'author' }),
    listMissionEvents: () => events,
    appendMissionEvent: vi.fn(),
  };
  const tools: { source: 'MCP'; workflowPurposes?: ['RESEARCH'] }[] = [];
  const adapter = new WorkflowMissionAdapter(
    {} as never,
    store as never,
    {} as never,
    {} as never,
    {} as never,
    () => 'workspace',
    { detail: () => detail } as never,
    () => tools as never,
    undefined,
    () => reviewers,
  );
  return { adapter, detail, step, definition, tools };
}
describe('research uses existing routing and honest review ownership', () => {
  it('refuses final delivery when a previous completed raw result was changed', async () => {
    const root = join(process.cwd(), '.test-data', `w23-raw-integrity-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'raw.json'), '{"changed":true}', 'utf8');
    const f = fixture();
    f.detail.steps.push({ id: 'experiment', stepId: 'R08', state: 'COMPLETED' } as WorkflowStepRun);
    f.detail.artifacts = [
      {
        kind: 'FILE',
        producerStepRunId: 'experiment',
        metadata: {
          outputKey: 'research.raw_result',
          path: 'raw.json',
          contentHash: createHash('sha256').update('{"original":true}').digest('hex'),
        },
      } as never,
    ];
    const adapter = new WorkflowMissionAdapter(
      {} as never,
      {
        getMission: () => ({ id: 'final', state: 'COMPLETED' }),
        listRuns: () => [{ id: 'final-run', status: 'COMPLETED', resultText: null }],
        listMissionEvents: () => [],
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () => root,
      { detail: () => f.detail } as never,
    );
    await expect(
      adapter.collectOutputs('final', root, { id: 'R14' } as WorkflowStepDefinition, {
        workflowRunId: 'workflow',
        stepRunId: 'final-step',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_CHANGED' });
  });
  it('forces external mode into Human Bridge without treating it as a model Task', async () => {
    const f = fixture('HUMAN_OR_EXTERNAL');
    f.tools.push({ source: 'MCP' });
    expect(
      await f.adapter.prepareExecution({ ...f.definition, id: 'R08' }, f.detail, {
        ...f.step,
        stepId: 'R08',
      }),
    ).toEqual({ routing: { executionConstraint: 'HUMAN_BRIDGE' } });
  });
  it.each(['COMPUTATIONAL', 'MIXED'])(
    '%s requires actual experiment Tool execution',
    async (mode) => {
      const f = fixture(mode);
      expect(
        await f.adapter.prepareExecution({ ...f.definition, id: 'R08' }, f.detail, {
          ...f.step,
          stepId: 'R08',
        }),
      ).toEqual({ reason: 'RESEARCH_EXPERIMENT_TOOL_REQUIRED' });
      f.tools.push({ source: 'MCP', workflowPurposes: ['RESEARCH'] });
      expect(
        await f.adapter.prepareExecution({ ...f.definition, id: 'R08' }, f.detail, {
          ...f.step,
          stepId: 'R08',
        }),
      ).toEqual({
        routing: {
          executionConstraint: 'SOLO',
          requiredCapabilities: ['GENERAL_REASONING', 'TOOL_USE'],
        },
      });
    },
  );
  it('requests explicit human sources when no research tool or actual source reference is available', async () => {
    const f = fixture();
    expect(
      await f.adapter.prepareExecution({ ...f.definition, id: 'R02' }, f.detail, {
        ...f.step,
        stepId: 'R02',
      }),
    ).toEqual({ routing: { executionConstraint: 'HUMAN_BRIDGE' } });
  });
  it('excludes every actual author actor, not a denied or other-Run target', async () => {
    const f = fixture('COMPUTATIONAL', ['author', 'member', 'reviewer']);
    expect(await f.adapter.prepareExecution(f.definition, f.detail, f.step)).toEqual({
      routing: { executionConstraint: 'SOLO', excludedTeammateIds: ['author', 'member'] },
    });
  });
  it('allows a sole qualified author without pretending independence', async () => {
    const f = fixture('COMPUTATIONAL', ['author']);
    expect(await f.adapter.prepareExecution(f.definition, f.detail, f.step)).toEqual({
      routing: { executionConstraint: 'SOLO' },
    });
  });
});
