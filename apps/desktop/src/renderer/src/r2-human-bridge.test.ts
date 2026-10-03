import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExternalWorkRequest } from '@cultivation/domain';
import { HumanBridgeRequestPresentation } from './r2-human-bridge.js';

const request: ExternalWorkRequest = {
  id: 'request-1',
  missionId: 'mission-1',
  runId: 'run-1',
  requesterTeammateId: 'teammate-1',
  assigneeTeammateId: 'human-bridge-1',
  capability: 'VIDEO_EDITING',
  title: '完成新闻视频剪辑',
  prompt:
    'Objective: Assemble the approved video. claimSafety: never add an unverified claim. Contract: news.video.draft must pass validation.',
  requirementsJson: { items: ['保持画面与配音同步。'] },
  targetArtifactsJson: {
    items: [
      {
        id: 'news.video.draft',
        name: 'draft.mp4',
        required: true,
        allowedExtensions: ['.mp4'],
        maxSizeBytes: 10_000_000,
      },
    ],
  },
  targetWorkspacePathsJson: { items: ['workflows/run-1/N12/output'] },
  acceptanceCriteriaJson: { items: ['画面和音轨均可播放。'] },
  externalAppProfileId: null,
  publicResult: null,
  state: 'PENDING',
  createdAt: '2026-10-03T00:00:00.000Z',
  submittedAt: null,
  resolvedAt: null,
};

describe('HumanBridgeRequestPresentation', () => {
  it('shows an actionable brief and keeps the full contract and artifact IDs collapsed', () => {
    const markup = renderToStaticMarkup(
      React.createElement(HumanBridgeRequestPresentation, { request }),
    );
    const disclosureStart = markup.indexOf('<details');
    expect(disclosureStart).toBeGreaterThan(0);
    const primary = markup.slice(0, disclosureStart);
    const advanced = markup.slice(disclosureStart);

    expect(primary).toContain('要做什么');
    expect(primary).toContain('完成新闻视频剪辑');
    expect(primary).toContain('需要交付');
    expect(primary).toContain('视频成片');
    expect(primary).toContain('保存到哪里');
    expect(primary).toContain('workflows/run-1/N12/output');
    expect(primary).toContain('验收重点');
    expect(primary).toContain('画面和音轨均可播放。');
    expect(primary).not.toContain('claimSafety');
    expect(primary).not.toContain('news.video.draft');

    expect(advanced).toContain('<summary>完整交付规范 / 高级信息</summary>');
    expect(advanced).toContain('claimSafety');
    expect(advanced).toContain('news.video.draft');
    expect(advanced).toContain('Objective: Assemble the approved video.');
  });
});
