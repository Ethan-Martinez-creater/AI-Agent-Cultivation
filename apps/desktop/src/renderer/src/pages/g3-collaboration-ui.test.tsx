import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { G3Collaboration } from '../components/G3Collaboration.js';
import { canCoordinateParty } from './parties.js';
import type {
  GenerationArtifactView,
  MissionExecutionView,
  MissionParticipantView,
  RuntimeProfileView,
  TeammateView,
} from '../ui-shared.js';

function teammate(id: string, runtimeId: string | null = `runtime-${id}`): TeammateView {
  return {
    id,
    name: `道友 ${id}`,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtimeId,
    executorKind: 'MODEL_RUNTIME',
    status: 'ACTIVE',
  };
}

function artifact(id: string): GenerationArtifactView {
  return {
    id,
    jobId: 'generation-job-internal',
    outputId: 'output-internal',
    kind: 'VIDEO',
    mimeType: 'video/mp4',
    extension: '.mp4',
    sizeBytes: 12_884_901,
    contentHash: 'sha256-private-hash',
    metadata: { width: 1920, height: 1080, durationSeconds: 8 },
    storageScope: 'MISSION_WORKSPACE',
    createdAt: '2026-10-06T00:00:00.000Z',
  };
}

function fixture(): {
  execution: MissionExecutionView;
  participants: MissionParticipantView[];
  teammates: TeammateView[];
} {
  const ids = [
    'delegated',
    'generating',
    'input',
    'capability',
    'human',
    'retry',
    'done',
    'review',
  ];
  const teammates = ids.map((id) => teammate(id));
  const participants = ids.map((id, index) => ({
    missionId: 'mission-private-id',
    teammateId: id,
    role: index === 7 ? 'REVIEWER' : index === 0 ? 'COORDINATOR' : 'MEMBER',
    sortOrder: index,
  }));
  const states = [
    'PREPARED',
    'RUNNING',
    'WAITING_INPUT',
    'WAITING_CAPABILITY',
    'WAITING_USER',
    'RETRYING',
    'COMPLETED',
    'RUNNING',
  ];
  const attempts = ids.map((id, index) => ({
    id: `attempt-${id}-private`,
    taskId: `task-${id}-private`,
    attemptNo: index === 5 ? 2 : 1,
    participantTeammateId: id,
    executionProtocol: index === 1 ? ('GENERATION' as const) : ('LANGUAGE' as const),
    state: states[index]!,
    generationJobId: index === 1 ? 'job-private-id' : undefined,
    errorCode: index === 5 ? 'TEMPORARY_ERROR' : undefined,
    createdAt: '2026-10-06T00:00:00.000Z',
  }));
  const outcomes = [
    { index: 2, kind: 'NEEDS_INPUT' },
    { index: 3, kind: 'NEEDS_CAPABILITY' },
    { index: 4, kind: 'WAITING_USER' },
    { index: 6, kind: 'COMPLETED' },
  ].map(({ index, kind }) => ({
    id: `outcome-${ids[index]}-private`,
    attemptId: attempts[index]!.id,
    participantTeammateId: ids[index]!,
    outcome: {
      kind,
      publicResult: index === 6 ? '视频成果已交付。' : undefined,
      artifactRefs:
        index === 6
          ? [
              {
                id: 'artifact-private-id',
                kind: 'VIDEO',
                mimeType: 'video/mp4',
                contentHash: 'sha256-private-hash',
                sizeBytes: 12_884_901,
              },
            ]
          : [],
    },
    consumedAt: index === 6 ? '2026-10-06T00:01:00.000Z' : null,
  }));
  const execution: MissionExecutionView = {
    tasks: ids.map((id, index) => ({
      id: `task-${id}-private`,
      participantTeammateId: id,
      role: index === 7 ? 'REVIEWER' : undefined,
      description: index === 0 ? '整理研究资料' : undefined,
    })),
    attempts,
    outcomes,
    artifacts: [artifact('artifact-private-id')],
  };
  return { execution, participants, teammates };
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
}

describe('G3 collaboration mission UI', () => {
  it('keeps execution prompt markers in Advanced and shows the actual task in the primary view', () => {
    const props = fixture();
    props.execution.tasks[0]!.description =
      'MEMBER_TASK: Contribute to this Mission: 生成一张参考图片 __G3_IMAGE__';
    const html = renderToStaticMarkup(createElement(G3Collaboration, props));
    const primary = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(primary).toContain('生成一张参考图片');
    expect(primary).not.toMatch(/MEMBER_TASK|Contribute to this Mission|__G3_IMAGE__/);
    expect(html).toContain('MEMBER_TASK');
  });

  it('shows a retry for the actual successor task even when its local attempt number is one', () => {
    const props = fixture();
    const task = { ...props.execution.tasks[1]!, retryNo: 1 };
    props.execution.tasks = [task];
    props.execution.attempts = props.execution.attempts
      .filter((attempt) => attempt.taskId === task.id)
      .map((attempt) => ({ ...attempt, state: 'RUNNING', attemptNo: 1 }));
    props.execution.outcomes = [];
    const html = renderToStaticMarkup(createElement(G3Collaboration, props));
    expect(html).toContain('正在重试');
    expect(html).not.toContain('正在生成');
  });

  it('keeps a completed generation in review until the actual review fact is committed', () => {
    const props = fixture();
    const task = { ...props.execution.tasks[6]!, reviewPending: true };
    props.execution.tasks = [task];
    props.execution.attempts = props.execution.attempts.filter(
      (attempt) => attempt.taskId === task.id,
    );
    props.execution.outcomes = props.execution.outcomes.filter((outcome) =>
      props.execution.attempts.some((attempt) => attempt.id === outcome.attemptId),
    );
    const html = renderToStaticMarkup(createElement(G3Collaboration, props));
    expect(html).toContain('正在审查');
    expect(html).toContain('0 / 1 项已完成');
  });

  it('shows friendly execution progress and keeps internal identifiers in the advanced disclosure', () => {
    const props = fixture();
    const html = renderToStaticMarkup(createElement(G3Collaboration, props));
    const defaultView = html.replace(/<details[\s\S]*?<\/details>/g, '');

    for (const label of [
      '已委派',
      '正在生成',
      '需要素材',
      '请求能力',
      '等待本尊',
      '正在重试',
      '完成',
      '正在审查',
    ]) {
      expect(defaultView).toContain(label);
    }
    expect(defaultView).toContain('整理研究资料');
    expect(defaultView).toContain('视频成果已交付。');
    expect(defaultView).not.toMatch(
      /task-(?:delegated|generating|input|capability|human|retry|done|review)-private|attempt-[a-z]+-private|job-private-id|TEMPORARY_ERROR|WAITING_INPUT/,
    );
    expect(html).toContain('task-delegated-private');
    expect(html).toContain('TEMPORARY_ERROR');
  });

  it('uses safe artifact preview access and displays output metadata without exposing its hash', () => {
    const props = fixture();
    const html = renderToStaticMarkup(createElement(G3Collaboration, props));
    const defaultView = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(defaultView).toContain('video/mp4');
    expect(defaultView).toContain('12.3 MB');
    expect(defaultView).toContain('1920 × 1080');
    expect(defaultView).toContain('8 秒');
    expect(defaultView).not.toContain('sha256-private-hash');

    const component = readSource('../components/G3Collaboration.tsx');
    expect(component).toContain('window.cultivation.generationChat.artifactUrl(reference.id)');
    expect(component).not.toMatch(/\bfetch\s*\(/);
    expect(component).not.toMatch(/storageKey|filePath|providerUrl/);
  });

  it('keeps the task layout responsive at tablet and narrow widths', () => {
    const css = readSource('./mission-party.css');
    expect(css).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*?\.g3-task-grid\s*\{\s*grid-template-columns:\s*repeat\(2,/,
    );
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.g3-task-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it('allows Generation teammates as members while excluding them from coordinator choices', () => {
    const generationTeammate = teammate('generation');
    const generationRuntime: RuntimeProfileView = {
      id: 'runtime-generation',
      name: '视频生成',
      providerId: 'provider',
      credentialId: null,
      modelId: 'minimax-h3',
      executionProtocol: 'GENERATION',
    };
    expect(canCoordinateParty(generationTeammate, [generationRuntime])).toBe(false);
    expect(
      canCoordinateParty(teammate('language'), [
        { ...generationRuntime, id: 'runtime-language', executionProtocol: 'LANGUAGE' },
      ]),
    ).toBe(true);
    expect(canCoordinateParty({ ...teammate('human'), executorKind: 'USER_BRIDGE' }, [])).toBe(
      false,
    );

    const parties = readSource('./parties.tsx');
    expect(parties).toContain('teammates.map((teammate) => {');
    expect(parties).toContain('.filter(isCoordinatorEligible)');
    expect(parties).toContain('window.cultivation.runtimes.list()');
  });
});
