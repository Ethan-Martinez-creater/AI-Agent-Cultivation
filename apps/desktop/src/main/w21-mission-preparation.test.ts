import { describe, expect, it } from 'vitest';
import { WorkflowMissionAdapter, boundedResearchMetadata } from './w1-mission-adapter.js';
import type {
  WorkflowDetail,
  WorkflowStepRun,
  ToolDescriptor,
  WorkflowArtifact,
} from '@cultivation/domain';
import { AI_NEWS_VIDEO_VERSION_1 } from '../../../../packages/application/src/builtin/ai-news-video/v1.js';

function adapter(root: string | null, tools: ToolDescriptor[] = []) {
  // Preparation cannot call routing, execute a tool, or start a Mission.
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('Execution is forbidden during preparation');
      },
    },
  );
  return new WorkflowMissionAdapter(
    forbidden as never,
    forbidden as never,
    forbidden as never,
    forbidden as never,
    forbidden as never,
    () => root,
    undefined,
    () => tools,
  );
}
const detail = {
  version: AI_NEWS_VIDEO_VERSION_1,
  run: { inputSnapshot: {} },
} as unknown as WorkflowDetail;
const attempt = {} as WorkflowStepRun;
describe('news preparation keeps existing execution authority', () => {
  it('bounds source metadata chunks while retaining every source and event', () => {
    const references = Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.test/${index}`,
      contentHash: 'a'.repeat(64),
      evidenceEventId: 'event'.repeat(12),
      actorId: 'actor'.repeat(12),
    }));
    const metadata = boundedResearchMetadata(references);
    expect(Object.values(metadata).every((value) => value.length <= 1900)).toBe(true);
    expect(Object.values(metadata).flatMap((value) => JSON.parse(value))).toEqual(references);
    expect(() => boundedResearchMetadata([{ url: 'x'.repeat(2000) }])).toThrow(/上限/);
  });
  it('revalidates final Human Bridge artifact against accepted same-Run delivery facts', () => {
    const file = {
      id: 'file',
      submittedAt: 'now',
      path: 'assets.json',
      fileName: 'assets.json',
      extension: '.json',
      sizeBytes: 30,
      metadataJson: { targetArtifactId: 'news.asset_registry', contentHash: 'a'.repeat(64) },
    };
    const request = {
      id: 'request',
      state: 'ACCEPTED',
      assigneeTeammateId: 'human',
      submittedAt: 'now',
    };
    const step = { stepId: 'N10', workflowRunId: 'workflow' };
    const value = new WorkflowMissionAdapter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listExternalWorkRequests: () => [request],
        getExternalWorkRequest: () => ({ artifacts: [file] }),
      } as never,
      () => null,
      { findStepByMissionId: () => step, detail: () => detail } as never,
    );
    const artifact = {
      id: 'workflow-artifact',
      workflowRunId: 'workflow',
      producerStepRunId: 'step',
      content: '{}',
      contentHash: 'c'.repeat(64),
      inputArtifactIds: [],
      createdAt: 'now',
      source: 'HUMAN_BRIDGE',
      sourceId: 'file',
      actorId: 'human',
      missionId: 'mission',
      missionRunId: 'run',
      kind: 'JSON',
      metadata: {
        outputKey: 'news.asset_registry',
        targetArtifactId: 'news.asset_registry',
        path: 'assets.json',
        fileName: 'assets.json',
        extension: '.json',
        sizeBytes: 30,
        contentHash: 'a'.repeat(64),
      },
    } as WorkflowArtifact;
    expect(value.hasAcceptedArtifactProvenance(artifact)).toBe(true);
    artifact.metadata.contentHash = 'b'.repeat(64);
    expect(value.hasAcceptedArtifactProvenance(artifact)).toBe(false);
    artifact.metadata.contentHash = 'a'.repeat(64);
    request.state = 'SUBMITTED';
    expect(value.hasAcceptedArtifactProvenance(artifact)).toBe(false);
  });
  it('requires the selected Workspace before routing', async () => {
    const definition = AI_NEWS_VIDEO_VERSION_1.steps[0]!;
    expect(await adapter(null).prepareExecution(definition, detail, attempt)).toEqual({
      reason: 'WORKSPACE_REQUIRED',
    });
  });
  it('requests existing Human Bridge execution when Research tools are absent', async () => {
    const definition = AI_NEWS_VIDEO_VERSION_1.steps[0]!;
    expect(await adapter('E:/workspace').prepareExecution(definition, detail, attempt)).toEqual({
      routing: { executionConstraint: 'HUMAN_BRIDGE' },
    });
    expect(
      await adapter('E:/workspace', [
        { workflowPurposes: ['RESEARCH'] } as ToolDescriptor,
      ]).prepareExecution(definition, detail, attempt),
    ).toEqual({});
  });
  it('respects explicit human narration while preserving ordinary W1 behavior', async () => {
    const definition = AI_NEWS_VIDEO_VERSION_1.steps.find((item) => item.id === 'N11')!;
    expect(
      await adapter('E:/workspace', [
        { workflowPurposes: ['VOICEOVER'] } as ToolDescriptor,
      ]).prepareExecution(
        definition,
        { ...detail, run: { ...detail.run, inputSnapshot: { narrationMode: 'HUMAN' } } },
        attempt,
      ),
    ).toEqual({ routing: { executionConstraint: 'HUMAN_BRIDGE' } });
    expect(
      await adapter(null).prepareExecution(
        definition,
        { ...detail, version: { ...detail.version, validationPolicy: undefined } },
        attempt,
      ),
    ).toEqual({});
  });
});
