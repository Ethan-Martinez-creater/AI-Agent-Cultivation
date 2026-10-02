import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowArtifact, WorkflowArtifactBinding } from '@cultivation/domain';
import { Switch } from './Switch.js';
import { WorkflowArtifactResult } from './WorkflowArtifactResult.js';
import { RoutingConfigPanel, type RoutingConfigView } from '../r4-routing.js';

describe('product controls and primary results', () => {
  it('renders accessible controlled switches with disabled state', () => {
    const markup = renderToStaticMarkup(
      createElement(Switch, {
        label: '启用连接',
        checked: true,
        disabled: true,
        onChange: () => {},
      }),
    );
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="启用连接"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('checkbox');
    expect(
      renderToStaticMarkup(
        createElement(Switch, { label: '启用连接', checked: false, onChange: () => {} }),
      ),
    ).toContain('aria-checked="false"');
  });

  it('uses a Switch for routing while leaving config authority outside the component', () => {
    const markup = renderToStaticMarkup(
      createElement(RoutingConfigPanel, {
        config: { cloudEnabled: false } as RoutingConfigView,
        onChange: async () => {},
        onOpenJevSettings: () => {},
      }),
    );
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-label="Cloud 智能分配"');
    expect(markup).not.toContain('type="checkbox"');
  });

  it('shows a friendly primary result while preserving technical facts in Advanced', () => {
    const artifact: WorkflowArtifact = {
      id: 'artifact-1',
      workflowRunId: 'workflow-run-1',
      producerStepRunId: 'step-run-1',
      missionId: 'mission-1',
      missionRunId: 'mission-run-1',
      actorId: 'teammate-1',
      sourceId: 'source-1',
      source: 'MISSION',
      kind: 'TEXT',
      content: '已整理需求与验收要点。',
      contentHash: 'original-hash',
      metadata: {},
      inputArtifactIds: [],
      createdAt: '2026-10-02T00:00:00Z',
    };
    const binding: WorkflowArtifactBinding = {
      id: 'binding-1',
      workflowRunId: 'workflow-run-1',
      stepRunId: 'step-run-1',
      key: 'summary',
      artifactId: artifact.id,
      role: 'OUTPUT',
      contractId: 'result.summary',
      contractVersion: '1',
      createdAt: artifact.createdAt,
    };
    const markup = renderToStaticMarkup(
      createElement(WorkflowArtifactResult, { artifact, label: 'summary', binding }),
    );
    const primary = markup.match(/<summary>(.*?)<\/summary>/)?.[1];
    expect(primary).toBe('文本结果');
    expect(primary).not.toMatch(/summary|TEXT|Mission|MISSION|contract/i);
    const advanced = markup.slice(markup.indexOf('workflow-technical-details'));
    for (const fact of [
      'summary',
      'TEXT',
      'MISSION',
      'step-run-1',
      'mission-run-1',
      'original-hash',
      'result.summary',
    ]) {
      expect(advanced).toContain(fact);
    }
    expect(markup).not.toContain(' open=');
  });
});
