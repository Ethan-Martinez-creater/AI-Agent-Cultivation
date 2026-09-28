import { describe, expect, it } from 'vitest';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import {
  DECISION_STATE_BUDGET,
  DecisionStateBuilder,
  canonicalDecisionJson,
} from './r3-decision-state.js';

const builder = new DecisionStateBuilder();

describe('R3 DecisionStateBuilder', () => {
  it('creates probability and hard-requirement questions for all fourteen dimensions in Chinese and English', () => {
    const chinese = builder.buildTaskCapability({
      taskSummary: '请分析一段中文任务，并生成图像。',
    });
    const english = builder.buildTaskCapability({
      taskSummary: 'Analyze a short task and generate an image.',
    });

    expect(Object.keys(chinese.questions)).toEqual(
      CAPABILITY_DIMENSIONS.flatMap((dimension) => [
        `demand.${dimension}.probability`,
        `demand.${dimension}.required`,
      ]),
    );
    expect(
      CAPABILITY_DIMENSIONS.every(
        (dimension) =>
          chinese.questions[`demand.${dimension}.probability`]?.type === 'noul' &&
          chinese.questions[`demand.${dimension}.required`]?.type === 'choice',
      ),
    ).toBe(true);
    expect(chinese.state.taskSummary).toContain('中文');
    expect(english.state.taskSummary).toContain('generate an image');
  });

  it('only includes allowlisted candidate metadata and excludes unverified experience and secret-like text', () => {
    const request = builder.buildTeammateFit({
      taskSummary: 'Compare this task against candidates.',
      explicitTeammateId: 'teammate-explicit',
      candidates: [
        {
          id: 'teammate-a',
          roleTitle: 'Visual specialist sk-abcdefghijklmnop',
          capabilities: {
            IMAGE_GENERATION: { status: 'SUPPORTED', score: 82 },
            VIDEO_GENERATION: { status: 'UNSUPPORTED', score: null },
            CODING: { status: 'UNCONFIGURED', score: null },
            TOOL_USE: { status: 'SUPPORTED', score: 0 },
          },
          enabledSkills: [
            {
              id: 'skill-1',
              name: 'Image craft',
              category: 'visual',
              summary: 'Prompt and composition',
            },
          ],
          verifiedExperiences: [
            {
              verified: true,
              type: 'MISSION_RESULT',
              mode: 'SOLO',
              outcome: 'COMPLETED',
              role: 'Coordinator',
              createdAt: '2026-01-02T00:00:00.000Z',
            },
            {
              verified: false,
              type: 'COLLABORATION',
              mode: 'CONSULTATION',
              outcome: 'COMPLETED',
              role: 'Member',
              createdAt: '2026-01-03T00:00:00.000Z',
            },
          ],
          privateMemory: 'raw private memory must never leave Main',
          chatHistory: 'full conversation must never leave Main',
        } as never,
      ],
    });
    const serialized = canonicalDecisionJson(request.state);

    expect(serialized).not.toContain('privateMemory');
    expect(serialized).not.toContain('raw private memory');
    expect(serialized).not.toContain('chatHistory');
    expect(serialized).not.toContain('full conversation');
    expect(serialized).not.toContain('sk-abcdefghijklmnop');
    expect(serialized).toContain('UNSUPPORTED');
    expect(serialized).toContain('UNCONFIGURED');
    expect(serialized).toContain('HIGH');
    expect(serialized).toContain('"TOOL_USE":{"band":"LOW","status":"SUPPORTED"}');
    expect(serialized).toContain('verifiedExperiences');
    expect(serialized).not.toContain('Member');
  });

  it('hashes canonical bounded state independent of candidate and skill insertion order', () => {
    const candidate = (id: string, skills: string[]) => ({
      id,
      roleTitle: id,
      capabilities: {},
      enabledSkills: skills.map((skillId) => ({
        id: skillId,
        name: skillId,
        category: null,
        summary: null,
      })),
      verifiedExperiences: [],
    });
    const first = builder.buildTeammateFit({
      taskSummary: 'Build a tool.',
      candidates: [candidate('b', ['z', 'a']), candidate('a', ['b'])],
    });
    const second = builder.buildTeammateFit({
      taskSummary: 'Build a tool.',
      candidates: [candidate('a', ['b']), candidate('b', ['a', 'z'])],
    });

    expect(first.stateHash).toBe(second.stateHash);
    expect(first.stateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the current Runtime capability projection supplied by the caller after migration', () => {
    const buildWithProjectedScore = (score: number) =>
      builder.buildTeammateFit({
        taskSummary: 'Write and review a small program.',
        candidates: [
          {
            id: 'same-teammate',
            roleTitle: 'Engineer',
            capabilities: { CODING: { status: 'SUPPORTED', score } },
            enabledSkills: [],
            verifiedExperiences: [],
          },
        ],
      });
    const runtimeA = buildWithProjectedScore(25);
    const runtimeB = buildWithProjectedScore(88);

    expect(runtimeA.stateHash).not.toBe(runtimeB.stateHash);
    expect(JSON.stringify(runtimeA.state)).toContain('LOW');
    expect(JSON.stringify(runtimeB.state)).toContain('HIGH');
  });

  it('caps candidate, skill, experience and serialized input budgets deterministically', () => {
    const request = builder.buildTeammateFit({
      taskSummary: '任务 '.repeat(5_000),
      candidates: Array.from({ length: 20 }, (_, index) => ({
        id: `teammate-${String(index).padStart(2, '0')}`,
        roleTitle: `角色 ${index}`,
        capabilities: {},
        enabledSkills: Array.from({ length: 10 }, (__, skillIndex) => ({
          id: `skill-${String(skillIndex).padStart(2, '0')}`,
          name: `功法 ${skillIndex}`,
          category: null,
          summary: 'bounded metadata',
        })),
        verifiedExperiences: Array.from({ length: 10 }, (__, experienceIndex) => ({
          verified: true,
          type: 'MISSION_RESULT' as const,
          mode: 'SOLO' as const,
          outcome: 'COMPLETED' as const,
          role: 'Coordinator',
          createdAt: new Date(Date.UTC(2025, 0, experienceIndex + 1)).toISOString(),
        })),
      })),
    });
    const state = request.state as {
      taskSummary: string;
      candidates: Array<{ enabledSkills: unknown[]; verifiedExperiences: unknown[] }>;
      candidatesTruncated: boolean;
    };

    expect(state.taskSummary.length).toBeLessThanOrEqual(900);
    expect(state.candidates).toHaveLength(DECISION_STATE_BUDGET.candidateCount);
    expect(state.candidates.every((candidate) => candidate.enabledSkills.length === 6)).toBe(true);
    expect(state.candidates.every((candidate) => candidate.verifiedExperiences.length === 6)).toBe(
      true,
    );
    expect(state.candidatesTruncated).toBe(true);
    expect(Buffer.byteLength(canonicalDecisionJson(request), 'utf8')).toBeLessThanOrEqual(
      DECISION_STATE_BUDGET.requestBytes,
    );
  });

  it('uses selected-mode metadata without treating unsupported capability as zero score', () => {
    const request = builder.buildCollaborationNeed({
      taskSummary: '需要手动提供视频成片。',
      eligibleCandidateCount: 2,
      selectedMode: 'SOLO',
    });
    const serialized = canonicalDecisionJson(request.state);
    expect(serialized).toContain('SOLO');
    expect(serialized).not.toContain('score');
  });
});
