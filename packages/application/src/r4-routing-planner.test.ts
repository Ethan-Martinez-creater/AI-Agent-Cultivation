import { describe, expect, it } from 'vitest';
import type {
  RoutingCandidateTrace,
  RoutingDecisionReceipt,
  RoutingPlanResult,
  RoutingTaskContext,
} from '@cultivation/domain';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import { R4_ROUTING_POLICY } from './r4-routing-planner.js';
import {
  makeHarness,
  teammate,
  humanBridge,
  taskContext,
  capabilityDemands,
  defaultDecision,
} from './testing/r4-routing-harness.js';
function trace(receipt: RoutingDecisionReceipt, teammateId: string): RoutingCandidateTrace {
  const result = receipt.candidates.find((candidate) => candidate.teammateId === teammateId);
  if (!result) throw new Error(`Missing routing trace for ${teammateId}`);
  return result;
}

function assigned(result: RoutingPlanResult): Extract<RoutingPlanResult, { status: 'ASSIGNED' }> {
  if (result.status !== 'ASSIGNED') throw new Error(`Expected assignment, got ${result.status}`);
  return result;
}

function actionRequired(
  result: RoutingPlanResult,
): Extract<RoutingPlanResult, { status: 'USER_ACTION_REQUIRED' }> {
  if (result.status !== 'USER_ACTION_REQUIRED') {
    throw new Error(`Expected user action, got ${result.status}`);
  }
  return result;
}

describe('RoutingPlanner', () => {
  it('hard excludes implementers before semantic fit or availability probe', async () => {
    const harness = makeHarness({
      teammates: [teammate('author'), teammate('reviewer')],
      scores: { author: { CODING: 100 }, reviewer: { CODING: 60 } },
    });
    const result = await harness.planner.plan(
      taskContext({
        requiredCapabilities: ['CODING'],
        executionConstraint: 'SOLO',
        excludedTeammateIds: ['author'],
      }),
    );
    expect(result.status).toBe('ASSIGNED');
    if (result.status === 'ASSIGNED')
      expect(result.assignment.coordinatorTeammateId).toBe('reviewer');
    expect(harness.probeOrder).toEqual(['reviewer']);
  });
  it.each([
    ['model', 'AUTO'],
    ['model', 'PARTY'],
    ['model', 'HUMAN_BRIDGE'],
    ['bridge', 'AUTO'],
    ['bridge', 'SOLO'],
    ['bridge', 'PARTY'],
    ['party', 'AUTO'],
    ['party', 'SOLO'],
    ['party', 'HUMAN_BRIDGE'],
  ] as const)(
    'rejects incompatible explicit %s / %s before any routing side effect',
    async (choice, executionConstraint) => {
      const harness = makeHarness({
        teammates: [teammate('model'), humanBridge()],
        scores: { model: { CODING: 90 } },
        humanBridgeSupports: true,
      });
      await expect(
        harness.planner.plan(
          taskContext({
            executionConstraint,
            ...(choice === 'party' ? { explicitPartyId: 'party' } : { explicitTeammateId: choice }),
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(harness.probeOrder).toEqual([]);
      expect(harness.receipts).toEqual([]);
      expect(harness.decisionGateway.requests).toEqual([]);
      expect(harness.eligibilityCalls).toEqual([]);
      expect(harness.semanticMetadataCalls).toEqual([]);
      expect(harness.bridgeSupportCalls).toBe(0);
    },
  );

  it.each(['AUTO', undefined] as const)(
    'permits only automatic routing (%s) to fall back with zero model candidates',
    async (executionConstraint) => {
      const harness = makeHarness({ teammates: [humanBridge()], humanBridgeSupports: true });
      const result = await harness.planner.plan(
        taskContext({ executionConstraint, requiredCapabilities: ['CODING'] }),
      );
      expect(assigned(result).assignment.kind).toBe('HUMAN_BRIDGE');
      expect(result.receipt.reason).toBe('HUMAN_BRIDGE_FALLBACK');
      expect(harness.probeOrder).toEqual([]);
    },
  );

  it.each(['zero', 'failed'] as const)(
    'never degrades SOLO into Human Bridge with %s callable models',
    async (scenario) => {
      const harness = makeHarness({
        teammates: scenario === 'zero' ? [humanBridge()] : [teammate('model'), humanBridge()],
        scores: { model: { CODING: 90 } },
        humanBridgeSupports: true,
        probes: { model: { ok: false, status: 'UNAVAILABLE' } },
      });
      const result = await harness.planner.plan(
        taskContext({ executionConstraint: 'SOLO', requiredCapabilities: ['CODING'] }),
      );
      expect(actionRequired(result).reason).toBe('SOLO_REQUIRES_MODEL_EXECUTOR');
      expect(result.receipt.assignment).toBeNull();
      expect(harness.bridgeSupportCalls).toBe(0);
      expect(harness.probeOrder).toEqual(scenario === 'zero' ? [] : ['model']);
    },
  );

  it.each([0, 1, 2])(
    'never degrades PARTY into SOLO/Human Bridge with %i initial models and fewer than two viable',
    async (count) => {
      const harness = makeHarness({
        teammates: [humanBridge(), ...['a', 'b'].slice(0, count).map((id) => teammate(id))],
        scores: { a: { CODING: 90 }, b: { CODING: 80 } },
        humanBridgeSupports: true,
        probes: { b: { ok: false, status: 'UNAVAILABLE' } },
      });
      const result = await harness.planner.plan(
        taskContext({ executionConstraint: 'PARTY', requiredCapabilities: ['CODING'] }),
      );
      expect(actionRequired(result).reason).toBe('PARTY_REQUIRES_TWO_EXECUTORS');
      expect(result.receipt.assignment).toBeNull();
      expect(harness.bridgeSupportCalls).toBe(0);
      expect(harness.probeOrder).toEqual(['a', 'b'].slice(0, count));
      expect(harness.maxConcurrentProbes).toBeLessThanOrEqual(1);
    },
  );

  it.each([true, false])(
    'HUMAN_BRIDGE never probes or chooses an available model (capability enabled=%s)',
    async (enabled) => {
      const harness = makeHarness({
        teammates: [teammate('model'), humanBridge()],
        scores: { model: { CODING: 100 } },
        humanBridgeSupports: enabled,
      });
      const result = await harness.planner.plan(
        taskContext({ executionConstraint: 'HUMAN_BRIDGE', requiredCapabilities: ['CODING'] }),
      );
      if (enabled) {
        expect(assigned(result).assignment).toMatchObject({
          kind: 'HUMAN_BRIDGE',
          coordinatorTeammateId: 'bridge',
        });
        expect(result.receipt.reason).toBe('HUMAN_BRIDGE_SELECTED');
      } else expect(actionRequired(result).reason).toBe('NO_CAPABLE_EXECUTOR');
      expect(result.receipt.candidates).toEqual([]);
      expect(harness.probeOrder).toEqual([]);
      expect(harness.decisionGateway.requests).toEqual([]);
      expect(harness.eligibilityCalls).toEqual([]);
    },
  );

  it('requires declared capability for Human Bridge without asking Jev to invent it', async () => {
    const harness = makeHarness({
      teammates: [teammate('model'), humanBridge()],
      humanBridgeSupports: true,
    });
    const result = await harness.planner.plan(taskContext({ executionConstraint: 'HUMAN_BRIDGE' }));
    expect(actionRequired(result).reason).toBe('HUMAN_BRIDGE_CAPABILITY_REQUIRED');
    expect(result.receipt.assignment).toBeNull();
    expect(harness.decisionGateway.requests).toEqual([]);
    expect(harness.probeOrder).toEqual([]);
  });

  it('does not fall back when every PARTY model fails its sequential probe', async () => {
    const harness = makeHarness({
      teammates: [teammate('a'), teammate('b'), humanBridge()],
      scores: { a: { CODING: 90 }, b: { CODING: 80 } },
      humanBridgeSupports: true,
      probes: { a: { ok: false, status: 'UNAVAILABLE' }, b: { ok: false, status: 'UNAVAILABLE' } },
    });
    const result = await harness.planner.plan(
      taskContext({ executionConstraint: 'PARTY', requiredCapabilities: ['CODING'] }),
    );
    expect(actionRequired(result).reason).toBe('PARTY_REQUIRES_TWO_EXECUTORS');
    expect(result.receipt.assignment).toBeNull();
    expect(harness.probeOrder).toEqual(['a', 'b']);
    expect(harness.bridgeSupportCalls).toBe(0);
  });

  it.each([
    ['model', undefined, 'SOLO'],
    ['model', 'SOLO', 'SOLO'],
    ['bridge', undefined, 'HUMAN_BRIDGE'],
    ['bridge', 'HUMAN_BRIDGE', 'HUMAN_BRIDGE'],
    ['party', undefined, 'PARTY'],
    ['party', 'PARTY', 'PARTY'],
  ] as const)(
    'accepts the compatible explicit %s / %s combination',
    async (choice, executionConstraint, kind) => {
      const harness = makeHarness({
        teammates: [teammate('model'), teammate('other'), humanBridge()],
        scores: { model: { CODING: 90 }, other: { CODING: 80 } },
        humanBridgeSupports: true,
        party: {
          id: 'party',
          status: 'ACTIVE',
          coordinatorTeammateId: 'model',
          memberTeammateIds: ['model', 'other'],
        },
      });
      const result = await harness.planner.plan(
        taskContext({
          executionConstraint,
          requiredCapabilities: ['CODING'],
          ...(choice === 'party' ? { explicitPartyId: 'party' } : { explicitTeammateId: choice }),
        }),
      );
      expect(assigned(result).assignment.kind).toBe(kind);
      expect(harness.decisionGateway.requests).toEqual([]);
      expect(harness.probeOrder).toEqual(
        choice === 'bridge' ? [] : choice === 'party' ? ['model', 'other'] : ['model'],
      );
    },
  );

  it('returns a typed action for a removed explicit identity without asking Benchmark for nonexistent history', async () => {
    const harness = makeHarness({
      teammates: [],
      eligibility: {
        removed: { eligible: false, runtimeProfileId: null, reason: 'TEAMMATE_NOT_FOUND' },
      },
    });
    const result = await harness.planner.plan(taskContext({ explicitTeammateId: 'removed' }));
    expect(result.status).toBe('USER_ACTION_REQUIRED');
    expect(actionRequired(result).reason).toBe('EXPLICIT_TEAMMATE_UNAVAILABLE');
    expect(harness.probeOrder).toEqual([]);
    expect(harness.decisionGateway.requests).toEqual([]);
  });
  it('keeps the explicit Party and mode, and refuses a failed member without substituting a third model', async () => {
    const make = (failed = false) =>
      makeHarness({
        teammates: [teammate('alpha'), teammate('beta'), teammate('other')],
        party: {
          id: 'fixed-party',
          status: 'ACTIVE',
          coordinatorTeammateId: 'alpha',
          memberTeammateIds: ['alpha', 'beta'],
        },
        probes: failed ? { beta: { ok: false, status: 'UNAVAILABLE' } } : {},
      });
    const good = make();
    const selected = await good.planner.plan(
      taskContext({ explicitPartyId: 'fixed-party', partyMode: 'REVIEW' }),
    );
    expect(assigned(selected).assignment).toMatchObject({
      kind: 'PARTY',
      partyId: 'fixed-party',
      mode: 'REVIEW',
      memberTeammateIds: ['alpha', 'beta'],
    });
    expect(good.probeOrder).toEqual(['alpha', 'beta']);
    expect(good.decisionGateway.requests).toEqual([]);
    const bad = make(true);
    const rejected = await bad.planner.plan(taskContext({ explicitPartyId: 'fixed-party' }));
    expect(actionRequired(rejected).reason).toBe('EXPLICIT_PARTY_UNAVAILABLE');
    expect(bad.probeOrder).toEqual(['alpha', 'beta']);
    expect(rejected.receipt.assignment).toBeNull();
  });
  it('rejects private context fields and invalid ExternalWork contracts before creating any routing facts', async () => {
    const harness = makeHarness({ teammates: [] });
    await expect(
      harness.planner.plan({ ...taskContext(), rawMemory: 'private' } as RoutingTaskContext),
    ).rejects.toThrow('任务上下文字段无效');
    await expect(
      harness.planner.plan(
        taskContext({
          expectedOutputContract: {
            name: 'x'.repeat(129),
            allowedExtensions: ['.txt'],
            maxSizeBytes: 100,
          },
        }),
      ),
    ).rejects.toThrow('产物交付约定无效');
    expect(harness.receipts).toEqual([]);
    expect(harness.probeOrder).toEqual([]);
  });
  it('excludes hard-filtered and provider-disabled models before semantic ranking', async () => {
    const harness = makeHarness({
      teammates: [teammate('provider-disabled'), teammate('unsupported')],
      scores: {
        'provider-disabled': { CODING: 100 },
        unsupported: { CODING: 100 },
      },
      eligibility: {
        'provider-disabled': { eligible: false, reason: 'PROVIDER_DISABLED' },
        unsupported: { eligible: false, reason: 'UNSUPPORTED_CAPABILITY' },
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('USER_ACTION_REQUIRED');
    expect(harness.semanticMetadataCalls).toEqual([]);
    expect(harness.probeOrder).toEqual([]);
    expect(harness.decisionGateway.requests).toEqual([]);
    expect(trace(result.receipt, 'provider-disabled')).toMatchObject({
      eligible: false,
      reason: 'PROVIDER_DISABLED',
    });
    expect(trace(result.receipt, 'unsupported')).toMatchObject({
      eligible: false,
      reason: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('keeps a supported zero benchmark distinct from unsupported and bounds fit bonus to eligible IDs', async () => {
    const harness = makeHarness({
      teammates: [
        teammate('zero-score'),
        teammate('benchmark-10'),
        teammate('provider-disabled'),
        teammate('unsupported'),
      ],
      scores: {
        'zero-score': { CODING: 0 },
        'benchmark-10': { CODING: 10 },
        'provider-disabled': { CODING: 100 },
        unsupported: { CODING: 100 },
      },
      eligibility: {
        'provider-disabled': { eligible: false, reason: 'PROVIDER_DISABLED' },
        unsupported: { eligible: false, reason: 'UNSUPPORTED_CAPABILITY' },
      },
      decide: (request) => {
        if (request.decisionType === 'TEAMMATE_FIT') {
          return {
            answers: { teammate: 'zero-score' },
            confidence: { teammate: 0.95 },
            selectedAction: 'zero-score',
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('ASSIGNED');
    expect(trace(result.receipt, 'zero-score')).toMatchObject({
      eligible: true,
      benchmarkScore: 0,
      semanticBonus: R4_ROUTING_POLICY.semanticBonus,
    });
    expect(trace(result.receipt, 'provider-disabled').semanticBonus).toBe(0);
    expect(trace(result.receipt, 'unsupported').semanticBonus).toBe(0);
    const fitRequest = harness.decisionGateway.requests.find(
      (request) => request.decisionType === 'TEAMMATE_FIT',
    );
    expect(fitRequest?.inputSummary.candidateIds).toEqual(['benchmark-10', 'zero-score']);
    expect(fitRequest?.inputSummary.candidateIds).not.toContain('provider-disabled');
    expect(fitRequest?.inputSummary.candidateIds).not.toContain('unsupported');
  });

  it('ignores a semantic recommendation for a hard-filtered ID', async () => {
    const harness = makeHarness({
      teammates: [teammate('available-model'), teammate('hard-filtered')],
      scores: { 'available-model': { CODING: 80 }, 'hard-filtered': { CODING: 100 } },
      eligibility: { 'hard-filtered': { eligible: false, reason: 'PROVIDER_DISABLED' } },
      decide: (request) => {
        if (request.decisionType === 'TEAMMATE_FIT') {
          return {
            answers: { teammate: 'hard-filtered' },
            confidence: { teammate: 0.99 },
            selectedAction: 'hard-filtered',
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('ASSIGNED');
    expect(assigned(result).assignment.coordinatorTeammateId).toBe('available-model');
    expect(trace(result.receipt, 'hard-filtered').semanticBonus).toBe(0);
    expect(trace(result.receipt, 'available-model').semanticBonus).toBe(0);
    expect(harness.semanticMetadataCalls).toEqual(['available-model']);
  });

  it('uses benchmark order and probes unknown candidates sequentially until one is available', async () => {
    const harness = makeHarness({
      teammates: [teammate('rank-90'), teammate('rank-80')],
      scores: { 'rank-90': { CODING: 90 }, 'rank-80': { CODING: 80 } },
      eligibility: {
        'rank-90': { availability: 'UNKNOWN' },
        'rank-80': { availability: 'UNKNOWN' },
      },
      probes: {
        'rank-90': { ok: false, status: 'UNSTABLE' },
        'rank-80': { ok: true, status: 'AVAILABLE' },
      },
      decide: (request) => {
        if (request.decisionType === 'TEAMMATE_FIT') {
          return {
            answers: { teammate: 'NONE' },
            confidence: { teammate: 0.9 },
            selectedAction: 'NONE',
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('ASSIGNED');
    expect(assigned(result).assignment.coordinatorTeammateId).toBe('rank-80');
    expect(harness.probeOrder).toEqual(['rank-90', 'rank-80']);
    expect(harness.maxConcurrentProbes).toBe(1);
    expect(trace(result.receipt, 'rank-90').probed).toBe(true);
    expect(trace(result.receipt, 'rank-80').probed).toBe(true);
    expect(trace(result.receipt, 'rank-90').reason).toBe('PROBE_UNAVAILABLE');
    expect(
      result.receipt.decisionSignals.find((signal) => signal.type === 'TEAMMATE_FIT'),
    ).toMatchObject({
      status: 'IGNORED',
      recommendation: 'NONE',
    });
  });

  it('freshly probes cached AVAILABLE candidates sequentially and skips a stale winner that fails', async () => {
    const harness = makeHarness({
      teammates: [teammate('cached-90'), teammate('cached-80')],
      scores: { 'cached-90': { CODING: 90 }, 'cached-80': { CODING: 80 } },
      eligibility: {
        'cached-90': { availability: 'AVAILABLE' },
        'cached-80': { availability: 'AVAILABLE' },
      },
      probes: {
        'cached-90': { ok: false, status: 'UNAVAILABLE' },
        'cached-80': { ok: true, status: 'AVAILABLE' },
      },
      decide: (request) => {
        if (request.decisionType === 'TEAMMATE_FIT') {
          return {
            answers: { teammate: 'NONE' },
            confidence: { teammate: 0.9 },
            selectedAction: 'NONE',
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('ASSIGNED');
    expect(assigned(result).assignment.coordinatorTeammateId).toBe('cached-80');
    expect(harness.probeOrder).toEqual(['cached-90', 'cached-80']);
    expect(harness.probeRequests).toEqual([
      { teammateId: 'cached-90', freshProbe: true },
      { teammateId: 'cached-80', freshProbe: true },
    ]);
    expect(harness.maxConcurrentProbes).toBe(1);
    expect(trace(result.receipt, 'cached-90')).toMatchObject({
      probed: true,
      availability: 'UNAVAILABLE',
      eligible: false,
      reason: 'PROBE_UNAVAILABLE',
    });
    expect(trace(result.receipt, 'cached-80')).toMatchObject({
      probed: true,
      availability: 'AVAILABLE',
      eligible: true,
    });
    expect(
      result.receipt.decisionSignals.find((signal) => signal.type === 'TEAMMATE_FIT'),
    ).toMatchObject({
      status: 'IGNORED',
      recommendation: 'NONE',
    });
  });

  it('removes an unstable penalty after a successful availability recovery', async () => {
    const harness = makeHarness({
      teammates: [teammate('recovers')],
      scores: { recovers: { CODING: 70 } },
      eligibility: { recovers: { availability: 'UNSTABLE' } },
      probes: { recovers: { ok: true, status: 'AVAILABLE' } },
      decide: (request) => {
        if (request.decisionType === 'TEAMMATE_FIT') {
          return {
            answers: { teammate: 'NONE' },
            confidence: { teammate: 0.9 },
            selectedAction: 'NONE',
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext({ requiredCapabilities: ['CODING'] }));

    expect(result.status).toBe('ASSIGNED');
    expect(assigned(result).assignment.coordinatorTeammateId).toBe('recovers');
    expect(trace(result.receipt, 'recovers')).toMatchObject({
      availability: 'AVAILABLE',
      stabilityPenalty: 0,
      rankingScore: 70,
    });
  });

  it('retains a callable UNSTABLE candidate if the next higher-ranked candidate fails its probe', async () => {
    const harness = makeHarness({
      teammates: [teammate('a'), teammate('b'), humanBridge()],
      scores: { a: { CODING: 90 }, b: { CODING: 85 } },
      probes: { a: { ok: true, status: 'UNSTABLE' }, b: { ok: false, status: 'UNAVAILABLE' } },
      humanBridgeSupports: true,
      decide: (request) =>
        request.decisionType === 'TEAMMATE_FIT'
          ? { answers: { teammate: 'NONE' }, confidence: { teammate: 0.9 }, selectedAction: 'NONE' }
          : defaultDecision(request),
    });
    const result = await harness.planner.plan(
      taskContext({ requiredCapabilities: ['CODING'], executionConstraint: 'SOLO' }),
    );
    expect(assigned(result).assignment.coordinatorTeammateId).toBe('a');
    expect(assigned(result).assignment.kind).toBe('SOLO');
    expect(trace(result.receipt, 'a')).toMatchObject({
      availability: 'UNSTABLE',
      benchmarkScore: 90,
      rankingScore: 80,
    });
    expect(harness.probeOrder).toEqual(['a', 'b']);
    expect(harness.maxConcurrentProbes).toBe(1);
    expect(harness.bridgeSupportCalls).toBe(0);
  });

  it('does not replace an explicitly selected teammate after its probe fails', async () => {
    const harness = makeHarness({
      teammates: [teammate('explicit'), teammate('available-alternative')],
      scores: {
        explicit: { CODING: 10 },
        'available-alternative': { CODING: 100 },
      },
      probes: { explicit: { ok: false, status: 'UNSTABLE' } },
    });

    const result = await harness.planner.plan(
      taskContext({ explicitTeammateId: 'explicit', requiredCapabilities: ['CODING'] }),
    );

    expect(result.status).toBe('USER_ACTION_REQUIRED');
    expect(actionRequired(result).reason).toBe('EXPLICIT_TEAMMATE_UNAVAILABLE');
    expect(harness.probeOrder).toEqual(['explicit']);
    expect(harness.decisionGateway.requests).toEqual([]);
  });

  it('honors SOLO and PARTY constraints and ignores generic workflow execution metadata', async () => {
    const make = () =>
      makeHarness({
        teammates: [teammate('alpha'), teammate('beta')],
        scores: { alpha: { CODING: 90 }, beta: { CODING: 80 } },
        decide: (request) => {
          if (request.decisionType === 'TEAMMATE_FIT') {
            return {
              answers: { teammate: 'alpha' },
              confidence: { teammate: 0.9 },
              selectedAction: 'alpha',
            };
          }
          return defaultDecision(request);
        },
      });

    const solo = await make().planner.plan(
      taskContext({ requiredCapabilities: ['CODING'], executionConstraint: 'SOLO' }),
    );
    const workflowShaped = await make().planner.plan(
      taskContext({
        requiredCapabilities: ['CODING'],
        executionConstraint: 'SOLO',
        executionContext: {
          origin: 'workflow',
          executionId: 'workflow-run-1',
          stepId: 'step-2',
          stepType: 'agent',
        },
      }),
    );
    const party = await make().planner.plan(
      taskContext({ requiredCapabilities: ['CODING'], executionConstraint: 'PARTY' }),
    );

    expect(solo.status).toBe('ASSIGNED');
    expect(assigned(solo).assignment).toMatchObject({
      kind: 'SOLO',
      coordinatorTeammateId: 'alpha',
    });
    expect(workflowShaped.status).toBe('ASSIGNED');
    expect(assigned(workflowShaped).assignment).toMatchObject({
      kind: 'SOLO',
      coordinatorTeammateId: 'alpha',
    });
    expect(party.status).toBe('ASSIGNED');
    expect(assigned(party).assignment).toMatchObject({
      kind: 'PARTY',
      coordinatorTeammateId: 'alpha',
      memberTeammateIds: ['alpha', 'beta'],
    });
  });

  it('uses Human Bridge only after model probes fail and requires its capability to be enabled', async () => {
    const teammates = [teammate('model'), humanBridge()];
    const modelFails = {
      teammates,
      scores: { model: { CODING: 80 } },
      probes: { model: { ok: false, status: 'UNSTABLE' as const } },
    };
    const supported = makeHarness({ ...modelFails, humanBridgeSupports: true });
    const routedToBridge = await supported.planner.plan(
      taskContext({ requiredCapabilities: ['CODING'] }),
    );

    expect(routedToBridge.status).toBe('ASSIGNED');
    expect(assigned(routedToBridge).assignment.kind).toBe('HUMAN_BRIDGE');
    expect(supported.probeOrder).toEqual(['model']);
    expect(supported.bridgeSupportCalls).toBe(1);

    const availableModel = makeHarness({
      teammates,
      scores: { model: { CODING: 80 } },
      humanBridgeSupports: true,
    });
    const modelWins = await availableModel.planner.plan(
      taskContext({ requiredCapabilities: ['CODING'] }),
    );

    expect(modelWins.status).toBe('ASSIGNED');
    expect(assigned(modelWins).assignment.kind).toBe('SOLO');
    expect(availableModel.bridgeSupportCalls).toBe(0);

    const disabledCapability = makeHarness({ ...modelFails, humanBridgeSupports: false });
    const blocked = await disabledCapability.planner.plan(
      taskContext({ requiredCapabilities: ['CODING'] }),
    );

    expect(blocked.status).toBe('USER_ACTION_REQUIRED');
    expect(actionRequired(blocked).reason).toBe('NO_CAPABLE_EXECUTOR');
    expect(disabledCapability.probeOrder).toEqual(['model']);
  });

  it('requires user confirmation when task capability evidence has no credible hard demand', async () => {
    const harness = makeHarness({
      teammates: [teammate('model')],
      decide: (request) => {
        if (request.decisionType === 'TASK_CAPABILITY') {
          return {
            answers: { demands: capabilityDemands(null, 0.2) },
            confidence: Object.fromEntries(
              CAPABILITY_DIMENSIONS.map((dimension) => [`demand.${dimension}.required`, 0.9]),
            ),
            selectedAction: null,
          };
        }
        return defaultDecision(request);
      },
    });

    const result = await harness.planner.plan(taskContext());

    expect(result.status).toBe('USER_ACTION_REQUIRED');
    expect(actionRequired(result).reason).toBe('TASK_DEMAND_REQUIRES_CONFIRMATION');
    expect(result.receipt.demand).toEqual([]);
    expect(harness.probeOrder).toEqual([]);
  });
});
