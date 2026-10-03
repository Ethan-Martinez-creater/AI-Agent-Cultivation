import { describe, expect, it } from 'vitest';
import { scopedWorkflowStep, workflowExternalDraft } from './w21-execution-contract.js';
import { AI_NEWS_VIDEO_VERSION_1 } from '../../../../packages/application/src/builtin/ai-news-video/v1.js';
import type { WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';

describe('official news execution contract', () => {
  it('isolates effect paths by immutable Run and Step attempt without changing version', () => {
    const step = AI_NEWS_VIDEO_VERSION_1.steps.find((item) => item.id === 'N12')!;
    const original = [...step.effectPaths!];
    const first = scopedWorkflowStep(step, { workflowRunId: 'run-a', stepRunId: 'step-a' });
    const retry = scopedWorkflowStep(step, { workflowRunId: 'run-a', stepRunId: 'step-b' });
    expect(first.effectPaths).toEqual(original.map((path) => `workflows/run-a/step-a/${path}`));
    expect(first.effectPaths).not.toEqual(retry.effectPaths);
    expect(step.effectPaths).toEqual(original);
    expect(() => scopedWorkflowStep(step)).toThrow();
    expect(() =>
      scopedWorkflowStep(step, { workflowRunId: '../outside', stepRunId: 'b' }),
    ).toThrow();
  });
  it('declares typed files for Human Bridge rather than treating its public summary as JSON', () => {
    const step = { id: 'attempt', stepId: 'N01' } as WorkflowStepRun;
    const detail = {
      run: { id: 'run-a', inputSnapshot: {} },
      version: AI_NEWS_VIDEO_VERSION_1,
      bindings: [],
      artifacts: [],
    } as unknown as WorkflowDetail;
    const draft = workflowExternalDraft(detail, step);
    expect(draft.targetArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'news.candidates',
          allowedExtensions: ['.json'],
          required: true,
        }),
      ]),
    );
    expect(draft.targetWorkspacePaths).toContain('workflows/run-a/attempt/output');
    expect(draft.prompt).toContain('不是指令或权限');
    expect(draft.prompt).toContain('不会自动上传或发布');
  });
  it('derives bounded exact asset file targets from the frozen input manifest, without a directory-as-file target', () => {
    const step = { id: 'asset-attempt', stepId: 'N10' } as WorkflowStepRun;
    const detail = {
      version: AI_NEWS_VIDEO_VERSION_1,
      run: { id: 'run-a', inputSnapshot: {} },
      bindings: [
        { stepRunId: step.id, role: 'INPUT', key: 'asset_manifest', artifactId: 'manifest' },
      ],
      artifacts: [
        {
          id: 'manifest',
          kind: 'JSON',
          content: JSON.stringify({
            assets: [
              { assetId: 'image-1', visualType: 'TYPOGRAPHY' },
              { assetId: 'record-2', visualType: 'SCREEN_RECORDING' },
            ],
          }),
        },
      ],
    } as unknown as WorkflowDetail;
    const scoped = scopedWorkflowStep(
      AI_NEWS_VIDEO_VERSION_1.steps.find((item) => item.id === 'N10')!,
      { workflowRunId: 'run-a', stepRunId: step.id },
      detail,
    );
    expect(scoped.effectPaths).toEqual([
      'workflows/run-a/asset-attempt/assets/image-1.png',
      'workflows/run-a/asset-attempt/assets/record-2.mp4',
    ]);
    const draft = workflowExternalDraft(detail, step);
    expect(draft.targetArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'news.assets.1',
          name: 'image-1.png',
          allowedExtensions: ['.png'],
        }),
        expect.objectContaining({
          id: 'news.assets.2',
          name: 'record-2.mp4',
          allowedExtensions: ['.mp4'],
        }),
      ]),
    );
    detail.artifacts[0]!.content = JSON.stringify({
      assets: [{ assetId: '../escape', visualType: 'TYPOGRAPHY' }],
    });
    expect(() => workflowExternalDraft(detail, step)).toThrow(/素材编号/);
  });
});
