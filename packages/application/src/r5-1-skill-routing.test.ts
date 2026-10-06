import { describe, expect, it, vi } from 'vitest';
import type { Skill } from '@cultivation/domain';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import {
  SKILL_ROUTING_POLICY,
  SkillRoutingService,
  type SkillRoutingContext,
} from './r5-1-skill-routing.js';
import type { SkillServiceStore, TeammateSkillAssignment } from './skill-service.js';

const TEAMMATE = 'teammate-current';
const OBJECTIVE = 'review the source code and find defects';

function skill(id: string, name: string, options: Partial<Skill> = {}): Skill {
  return {
    id,
    name,
    description: options.description ?? '',
    instructions: options.instructions ?? `private instructions for ${id}`,
    version: options.version ?? '1.0.0',
    tags: options.tags ?? [],
    status: options.status ?? 'ACTIVE',
    createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: options.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function assignment(
  skillId: string,
  enabled = true,
  teammateId = TEAMMATE,
): TeammateSkillAssignment {
  return { teammateId, skillId, enabled };
}

function context(
  objective = OBJECTIVE,
  overrides: Partial<SkillRoutingContext> = {},
): SkillRoutingContext {
  return { objective, ...overrides };
}

function result(skills: Array<{ skillId: string; score: number }>): DecisionResult {
  return { answers: { skills }, confidence: {}, selectedAction: null };
}

class MemorySkillStore
  implements Pick<SkillServiceStore, 'getSkill' | 'listAssignmentsForTeammate'>
{
  readonly skills = new Map<string, Skill>();
  assignments: TeammateSkillAssignment[] = [];
  assignmentReads: string[] = [];
  skillReads = 0;
  onGetSkill?: (id: string, readNumber: number) => void;
  failAssignmentReads = false;
  returnAllAssignments = false;
  onReadAssignments?: (readNumber: number) => void;

  async getSkill(id: string): Promise<Skill | null> {
    this.skillReads += 1;
    const value = this.skills.get(id);
    const copy = value ? { ...value, tags: [...value.tags] } : null;
    this.onGetSkill?.(id, this.skillReads);
    return copy;
  }

  async listAssignmentsForTeammate(teammateId: string): Promise<TeammateSkillAssignment[]> {
    this.assignmentReads.push(teammateId);
    this.onReadAssignments?.(this.assignmentReads.length);
    if (this.failAssignmentReads) throw new Error('store unavailable');
    const rows = this.assignments.map((value) => ({ ...value }));
    return this.returnAllAssignments
      ? rows
      : rows.filter((value) => value.teammateId === teammateId);
  }
}

class FakeGateway implements DecisionGateway {
  readonly requests: DecisionRequest[] = [];

  constructor(
    private readonly answer:
      | DecisionResult
      | ((request: DecisionRequest) => DecisionResult | Promise<DecisionResult>),
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    return typeof this.answer === 'function' ? this.answer(request) : this.answer;
  }
}

function service(
  store: MemorySkillStore,
  gateway: () => Promise<DecisionGateway | null> = async () => null,
): SkillRoutingService {
  return new SkillRoutingService(store, gateway);
}

function candidateIds(gateway: FakeGateway): string[] {
  const state = gateway.requests[0]?.state as { candidates: Array<{ id: string }> };
  return state.candidates.map(({ id }) => id);
}

describe('SkillRoutingService', () => {
  it('shortlists only active, enabled assignments for the executing teammate', async () => {
    const store = new MemorySkillStore();
    store.skills.set('current', skill('current', 'Code review'));
    store.skills.set('disabled', skill('disabled', 'Code review'));
    store.skills.set('unassigned', skill('unassigned', 'Code review'));
    store.skills.set('other', skill('other', 'Code review'));
    store.skills.set('archived', skill('archived', 'Code review', { status: 'ARCHIVED' }));
    store.assignments = [
      assignment('current'),
      assignment('disabled', false),
      assignment('other', true, 'teammate-other'),
      assignment('archived'),
    ];
    store.returnAllAssignments = true;
    const gateway = new FakeGateway(result([{ skillId: 'current', score: 0.91 }]));
    const selection = await service(store, async () => gateway).select(TEAMMATE, context());

    expect(candidateIds(gateway)).toEqual(['current']);
    expect(selection.selectedSkillIds).toEqual(['current']);
    expect(selection.skillAssignments).toEqual([assignment('current')]);
    expect(store.assignmentReads).toEqual([TEAMMATE, TEAMMATE, TEAMMATE]);
    expect(selection.receipt.candidateIds).toEqual(['current']);
  });

  it('does not invoke Jev when no eligible candidates exist', async () => {
    const store = new MemorySkillStore();
    store.skills.set('disabled', skill('disabled', 'Code review'));
    store.assignments = [assignment('disabled', false)];
    let factoryCalls = 0;
    const selection = await service(store, async () => {
      factoryCalls += 1;
      return new FakeGateway(result([]));
    }).select(TEAMMATE, context());

    expect(factoryCalls).toBe(0);
    expect(selection).toMatchObject({
      skills: [],
      skillAssignments: [],
      selectedSkillIds: [],
      receipt: { mode: 'EMPTY', reason: 'NO_CANDIDATES', candidateIds: [] },
    });
  });

  it('bounds Jev to metadata and allowlisted step context without instructions or workflow history', async () => {
    const store = new MemorySkillStore();
    store.skills.set(
      'review',
      skill('review', 'Review checklist', {
        description: 'Bounded metadata description api_key=private-token-123',
        instructions: 'PRIVATE-INSTRUCTIONS-DO-NOT-SEND',
        tags: ['review'],
      }),
    );
    store.assignments = [assignment('review')];
    const gateway = new FakeGateway(result([{ skillId: 'review', score: 0.8 }]));
    const unsafeContext = {
      ...context('Review this artifact', {
        stepType: 'REVIEW',
        requiredCapabilities: ['CODING'],
        inputArtifactSummaries: [{ id: 'artifact-1', kind: 'TEXT', name: 'diff summary' }],
        expectedOutputContract: [
          { key: 'review', kind: 'JSON', contractId: 'review-v1', contractVersion: '1' },
        ],
        publicState: 'RUNNING',
      }),
      workflowHistory: 'PRIVATE-WORKFLOW-HISTORY-DO-NOT-SEND',
      privatePrompt: 'PRIVATE-PROMPT-DO-NOT-SEND',
    } as SkillRoutingContext & Record<string, unknown>;
    const selection = await service(store, async () => gateway).select(TEAMMATE, unsafeContext);

    const request = gateway.requests[0]!;
    const serializedRequest = JSON.stringify(request);
    const state = request.state as {
      candidates: Array<{ id: string; name: string; description: string; tags: string[] }>;
      context: Record<string, unknown>;
    };
    expect(Object.keys(state).sort()).toEqual(['candidates', 'context']);
    expect(state.candidates).toEqual([
      {
        id: 'review',
        name: 'Review checklist',
        description: 'Bounded metadata description [REDACTED]',
        tags: ['review'],
      },
    ]);
    expect(state.context).toEqual({
      objective: 'Review this artifact',
      stepType: 'REVIEW',
      requiredCapabilities: ['CODING'],
      inputArtifactSummaries: [{ id: 'artifact-1', kind: 'TEXT', name: 'diff summary' }],
      expectedOutputContract: [
        { key: 'review', kind: 'JSON', contractId: 'review-v1', contractVersion: '1' },
      ],
      publicState: 'RUNNING',
    });
    expect(serializedRequest).not.toContain('PRIVATE-INSTRUCTIONS-DO-NOT-SEND');
    expect(serializedRequest).not.toContain('private-token-123');
    expect(serializedRequest).not.toContain('PRIVATE-WORKFLOW-HISTORY-DO-NOT-SEND');
    expect(serializedRequest).not.toContain('PRIVATE-PROMPT-DO-NOT-SEND');
    expect(request.inputSummary.candidateIds).toEqual(['review']);
    expect(request.questions).toEqual({
      'skill.review': { type: 'noul', instructions: expect.any(String) },
    });
    expect(request.questions['skill.review']!.criteria).toBeUndefined();
    expect(selection.skills[0]?.instructions).toBe('PRIVATE-INSTRUCTIONS-DO-NOT-SEND');
  });

  it('ranks bounded candidate metadata using objective and step context with stable ID ties', async () => {
    const store = new MemorySkillStore();
    store.skills.set('a-task', skill('a-task', 'Task planning guide'));
    store.skills.set('z-review', skill('z-review', 'Review planning guide'));
    store.assignments = [assignment('z-review'), assignment('a-task')];

    const task = await service(store).select(
      TEAMMATE,
      context('planning help', { stepType: 'TASK' }),
    );
    const review = await service(store).select(
      TEAMMATE,
      context('planning help', { stepType: 'REVIEW' }),
    );
    expect(task.selectedSkillIds[0]).toBe('a-task');
    expect(review.selectedSkillIds[0]).toBe('z-review');

    const tiedStore = new MemorySkillStore();
    tiedStore.skills.set('b-skill', skill('b-skill', 'Code review'));
    tiedStore.skills.set('a-skill', skill('a-skill', 'Code review'));
    tiedStore.assignments = [assignment('b-skill'), assignment('a-skill')];
    const tied = await service(tiedStore).select(TEAMMATE, context());
    expect(tied.selectedSkillIds).toEqual(['a-skill', 'b-skill']);
    expect(tied.receipt.scores.map(({ skillId }) => skillId)).toEqual(['a-skill', 'b-skill']);
  });

  it('rejects unknown IDs, outside candidates, duplicates, more than three, and malformed output', async () => {
    const invalidResults: unknown[] = [
      result([{ skillId: 'missing-skill', score: 0.9 }]),
      result([{ skillId: 'outside-candidates', score: 0.9 }]),
      result([
        { skillId: 'a', score: 0.9 },
        { skillId: 'a', score: 0.8 },
      ]),
      result([
        { skillId: 'a', score: 0.9 },
        { skillId: 'b', score: 0.8 },
        { skillId: 'c', score: 0.7 },
        { skillId: 'd', score: 0.6 },
      ]),
      {
        answers: { skills: [{ skillId: 'a', score: 0.9, rationale: 'unexpected' }] },
        confidence: {},
        selectedAction: null,
      },
      { answers: { skills: [{ skillId: 'a', score: 1.1 }] }, confidence: {}, selectedAction: null },
      {
        answers: { skills: [{ skillId: 'a', score: 0.9 }] },
        confidence: { 'skill.a': 0.9 },
        selectedAction: null,
      },
      {
        answers: { skills: [{ skillId: 'a', score: 0.9 }], extra: 'unexpected' },
        confidence: {},
        selectedAction: null,
      },
      { answers: { skills: [{ skillId: 'a', score: 0.9 }] }, confidence: {}, selectedAction: 'a' },
      {
        answers: { skills: [{ skillId: 'a', score: 0.9 }] },
        confidence: {},
        selectedAction: null,
        unrecognizedEnvelopeField: true,
      },
    ];

    for (const invalid of invalidResults) {
      const store = new MemorySkillStore();
      for (const id of ['a', 'b', 'c', 'd']) {
        store.skills.set(id, skill(id, 'Code review'));
        store.assignments.push(assignment(id));
      }
      const gateway = new FakeGateway(invalid as DecisionResult);
      const selection = await service(store, async () => gateway).select(TEAMMATE, context());
      expect(selection.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
      expect(selection.receipt.reason).toBe('INVALID_RESPONSE');
      expect(selection.receipt.errorCode).toBe('SCHEMA_MISMATCH');
      expect(selection.selectedSkillIds).toEqual(['a', 'b', 'c']);
    }
  });

  it('rejects oversized decision results and falls back within the same candidate set', async () => {
    const store = new MemorySkillStore();
    for (const id of ['a', 'b', 'c', 'd']) {
      store.skills.set(id, skill(id, 'Code review'));
      store.assignments.push(assignment(id));
    }
    const oversized = {
      answers: { skills: [{ skillId: 'a', score: 0.9 }] },
      confidence: {},
      selectedAction: null,
      model: 'x'.repeat(SKILL_ROUTING_POLICY.maxDecisionResponseBytes + 1),
    } as DecisionResult;
    const gateway = new FakeGateway(oversized);
    const selection = await service(store, async () => gateway).select(TEAMMATE, context());

    expect(selection.receipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'INVALID_RESPONSE',
      errorCode: 'SCHEMA_MISMATCH',
      candidateIds: ['a', 'b', 'c', 'd'],
      selectedSkillIds: ['a', 'b', 'c'],
    });
  });

  it('uses explicit deterministic fallback when Jev is unavailable or errors', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review'));
    store.assignments = [assignment('review')];

    const unavailable = await service(store, async () => null).select(TEAMMATE, context());
    const throwing = await service(store, async () => {
      throw new Error('offline');
    }).select(TEAMMATE, context());
    const failed = await service(
      store,
      async () =>
        new FakeGateway({
          answers: {},
          confidence: {},
          selectedAction: null,
          errorCode: 'PROVIDER_UNAVAILABLE',
        }),
    ).select(TEAMMATE, context());

    expect(unavailable).toMatchObject({
      selectedSkillIds: ['review'],
      receipt: { mode: 'DETERMINISTIC_FALLBACK', reason: 'GATEWAY_UNAVAILABLE' },
    });
    expect(throwing.receipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'GATEWAY_ERROR',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(failed.receipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'GATEWAY_ERROR',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('accepts bounded provider telemetry from the Decision adapter', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review'));
    store.assignments = [assignment('review')];
    const response = {
      ...result([{ skillId: 'review', score: 0.9 }]),
      provider: 'typesafe',
      inputTokens: 120,
      outputTokens: 24,
    } as DecisionResult;
    const selection = await service(store, async () => new FakeGateway(response)).select(
      TEAMMATE,
      context(),
    );

    expect(selection.receipt.mode).toBe('JEV');
    expect(selection.selectedSkillIds).toEqual(['review']);
  });
  it('falls back to deterministic Top 1–3 when Jev returns no relevant skill', async () => {
    const store = new MemorySkillStore();
    for (const id of ['a', 'b', 'c', 'd']) {
      store.skills.set(id, skill(id, 'Code review'));
      store.assignments.push(assignment(id));
    }
    const gateway = new FakeGateway(result([]));
    const selection = await service(store, async () => gateway).select(TEAMMATE, context());

    expect(selection.selectedSkillIds).toEqual(['a', 'b', 'c']);
    expect(selection.receipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'JEV_NO_MATCH',
      errorCode: null,
    });
  });
  it('applies the six second gateway deadline and falls back', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemorySkillStore();
      store.skills.set('review', skill('review', 'Code review'));
      store.assignments = [assignment('review')];
      const gateway: DecisionGateway = {
        evaluate: () => new Promise<DecisionResult>(() => undefined),
      };
      const pending = service(store, async () => gateway).select(TEAMMATE, context());
      await vi.advanceTimersByTimeAsync(SKILL_ROUTING_POLICY.gatewayTimeoutMs + 1);
      const selection = await pending;

      expect(selection.selectedSkillIds).toEqual(['review']);
      expect(selection.receipt).toMatchObject({
        mode: 'DETERMINISTIC_FALLBACK',
        reason: 'GATEWAY_TIMEOUT',
        errorCode: 'TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks active status and teammate assignment after awaiting Jev', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review'));
    store.skills.set('other', skill('other', 'Code review'));
    store.assignments = [assignment('review'), assignment('other')];
    const gateway = new FakeGateway(() => {
      store.assignments = [assignment('review', false), assignment('other')];
      store.skills.set('other', skill('other', 'Code review', { status: 'ARCHIVED' }));
      return result([
        { skillId: 'review', score: 0.95 },
        { skillId: 'other', score: 0.9 },
      ]);
    });
    const selection = await service(store, async () => gateway).select(TEAMMATE, context());

    expect(selection.skills).toEqual([]);
    expect(selection.skillAssignments).toEqual([]);
    expect(selection.selectedSkillIds).toEqual([]);
    expect(selection.receipt).toMatchObject({
      mode: 'JEV',
      reason: 'STALE_SELECTION',
      selectedSkillIds: [],
    });
  });

  it('rechecks teammate assignment after loading selected Skills', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review'));
    store.assignments = [assignment('review')];
    store.onGetSkill = (_id, readNumber) => {
      if (readNumber === 2) store.assignments = [assignment('review', false)];
    };
    const gateway = new FakeGateway(result([{ skillId: 'review', score: 0.9 }]));
    const selection = await service(store, async () => gateway).select(TEAMMATE, context());

    expect(selection.selectedSkillIds).toEqual([]);
    expect(selection.skillAssignments).toEqual([]);
    expect(selection.receipt.reason).toBe('STALE_SELECTION');
    expect(store.assignmentReads).toHaveLength(3);
  });

  it('reduces long multibyte objectives without exceeding the context byte budget', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review'));
    store.assignments = [assignment('review')];
    const gateway = new FakeGateway(result([{ skillId: 'review', score: 0.9 }]));
    const longContext = context('界'.repeat(600));
    const pending = service(store, async () => gateway).select(TEAMMATE, longContext);
    const selection = await pending;

    const request = gateway.requests[0]!;
    const boundedContext = (request.state as { context: Record<string, unknown> }).context;
    expect(Buffer.byteLength(JSON.stringify(boundedContext), 'utf8')).toBeLessThanOrEqual(
      SKILL_ROUTING_POLICY.maxContextCharacters,
    );
    expect(selection.selectedSkillIds).toEqual(['review']);
  });
  it('returns EMPTY without blocking execution when ownership lookup fails', async () => {
    const store = new MemorySkillStore();
    store.failAssignmentReads = true;
    let factoryCalls = 0;
    const selection = await service(store, async () => {
      factoryCalls += 1;
      return null;
    }).select(TEAMMATE, context());

    expect(factoryCalls).toBe(0);
    expect(selection).toMatchObject({
      skills: [],
      selectedSkillIds: [],
      receipt: {
        mode: 'EMPTY',
        reason: 'OWNERSHIP_LOOKUP_FAILED',
        errorCode: 'OWNERSHIP_LOOKUP_FAILED',
      },
    });
  });

  it('caps candidate count and serialized state while preserving exact candidate IDs', async () => {
    const store = new MemorySkillStore();
    for (let index = 0; index < 40; index += 1) {
      const id = `skill-${String(index).padStart(2, '0')}`;
      store.skills.set(
        id,
        skill(id, `Code review skill ${index}`, {
          description: 'Detailed metadata '.repeat(100),
          tags: ['review', 'coding', 'workflow', 'artifact', 'release'],
          instructions: 'PRIVATE-LONG-INSTRUCTIONS',
        }),
      );
      store.assignments.push(assignment(id));
    }
    const gateway = new FakeGateway((request) =>
      result(
        request.inputSummary.candidateIds.slice(0, 3).map((skillId, index) => ({
          skillId,
          score: 1 - index * 0.1,
        })),
      ),
    );
    await service(store, async () => gateway).select(TEAMMATE, context('Code review'));

    const request = gateway.requests[0]!;
    const ids = candidateIds(gateway);
    expect(ids).toHaveLength(SKILL_ROUTING_POLICY.maxCandidates);
    expect(request.inputSummary.candidateIds).toEqual(ids);
    expect(Object.keys(request.questions)).toEqual(ids.map((id) => `skill.${id}`));
    expect(Buffer.byteLength(JSON.stringify(request.state), 'utf8')).toBeLessThanOrEqual(
      SKILL_ROUTING_POLICY.maxDecisionStateCharacters,
    );
    expect(JSON.stringify(request.state)).not.toContain('PRIVATE-LONG-INSTRUCTIONS');
  });

  it('records only bounded receipts with hashes, IDs, versions, and finite scores', async () => {
    const store = new MemorySkillStore();
    store.skills.set('review', skill('review', 'Code review', { instructions: 'SECRET-CONTENT' }));
    store.assignments = [assignment('review')];
    const gateway = new FakeGateway(result([{ skillId: 'review', score: 0.87654 }]));
    const selection = await service(store, async () => gateway).select(
      TEAMMATE,
      context('SECRET-OBJECTIVE-TEXT'),
    );
    const receiptJson = JSON.stringify(selection.receipt);

    expect(selection.receipt.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(selection.receipt).toMatchObject({
      mode: 'JEV',
      policyVersion: SKILL_ROUTING_POLICY.version,
      questionVersion: SKILL_ROUTING_POLICY.questionVersion,
      candidateIds: ['review'],
      selectedSkillIds: ['review'],
      scores: [{ skillId: 'review', score: 0.8765 }],
    });
    expect(receiptJson).not.toContain('SECRET-CONTENT');
    expect(receiptJson).not.toContain('SECRET-OBJECTIVE-TEXT');
    expect(Object.keys(selection.receipt).sort()).toEqual([
      'candidateIds',
      'errorCode',
      'inputHash',
      'mode',
      'policyVersion',
      'questionVersion',
      'reason',
      'scores',
      'selectedSkillIds',
    ]);
    expect(selection.receipt.scores.every(({ score }) => score >= 0 && score <= 1)).toBe(true);
  });
});
