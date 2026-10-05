import type {
  CapabilityDimension,
  RoutingDecisionReceipt,
  RoutingTaskContext,
  Teammate,
} from '@cultivation/domain';
import type { DecisionGateway, DecisionRequest, DecisionResult } from '../r0-decision.js';
import type { AvailabilityService, RoutingEligibilityService } from '../r3-2-availability.js';
import { CAPABILITY_DIMENSIONS } from '../r1-capability-scoring.js';
import { RoutingPlanner, type RoutingPlannerStore } from '../r4-routing-planner.js';

type AvailabilityState = 'UNKNOWN' | 'AVAILABLE' | 'UNSTABLE' | 'UNAVAILABLE';

interface EligibilityFixture {
  eligible: boolean;
  reason: string;
  availability: AvailabilityState;
  runtimeProfileId: string | null;
}

interface ProbeFixture {
  ok: boolean;
  status: AvailabilityState;
}

interface HarnessOptions {
  party?: ReturnType<RoutingPlannerStore['getParty']>;
  teammates: Teammate[];
  scores?: Record<string, Partial<Record<CapabilityDimension, number | null>>>;
  eligibility?: Record<string, Partial<EligibilityFixture>>;
  probes?: Record<string, ProbeFixture>;
  humanBridgeSupports?: boolean;
  decide?: (request: DecisionRequest) => DecisionResult;
}

class FakeDecisionGateway implements DecisionGateway {
  readonly requests: DecisionRequest[] = [];

  constructor(private readonly decide: (request: DecisionRequest) => DecisionResult) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    return this.decide(request);
  }
}

export function teammate(id: string, values: Partial<Teammate> = {}): Teammate {
  return {
    id,
    name: id,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    status: 'ACTIVE',
    realm: 'CORE',
    currentRuntimeProfileId: `profile-${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...values,
  };
}

export function humanBridge(id = 'bridge'): Teammate {
  return teammate(id, {
    executorKind: 'USER_BRIDGE',
    routingPolicy: 'FALLBACK_ONLY',
    systemKind: 'HUMAN_BRIDGE',
    currentRuntimeProfileId: null,
  });
}

export function taskContext(values: Partial<RoutingTaskContext> = {}): RoutingTaskContext {
  return {
    objective: 'Implement and review the routing change.',
    ...values,
  };
}

export function capabilityDemands(
  requiredDimension: CapabilityDimension | null = 'CODING',
  probability = 0.9,
) {
  return CAPABILITY_DIMENSIONS.map((dimension) => ({
    dimension,
    probability,
    required: dimension === requiredDimension,
  }));
}

export function defaultDecision(request: DecisionRequest): DecisionResult {
  if (request.decisionType === 'TASK_CAPABILITY') {
    return {
      answers: { demands: capabilityDemands() },
      confidence: Object.fromEntries(
        CAPABILITY_DIMENSIONS.map((dimension) => [`demand.${dimension}.required`, 0.9]),
      ),
      selectedAction: null,
    };
  }
  if (request.decisionType === 'TEAMMATE_FIT') {
    const id = request.inputSummary.candidateIds[0] ?? 'NONE';
    return { answers: { teammate: id }, confidence: { teammate: 0.9 }, selectedAction: id };
  }
  return {
    answers: { collaboration: 'NO' },
    confidence: { collaboration: 0.9 },
    selectedAction: 'NO',
  };
}

export function makeHarness(options: HarnessOptions) {
  const receipts: RoutingDecisionReceipt[] = [];
  const decisionGateway = new FakeDecisionGateway(options.decide ?? defaultDecision);
  const probeOrder: string[] = [];
  const probeRequests: Array<{ teammateId: string; freshProbe?: boolean }> = [];
  const semanticMetadataCalls: string[] = [];
  const eligibilityCalls: Array<{ id: string; explicit: boolean }> = [];
  let bridgeSupportCalls = 0;
  let activeProbes = 0;
  let maxConcurrentProbes = 0;
  const probedStatuses = new Map<string, AvailabilityState>();
  const probeResults = new Map<string, ProbeFixture>();

  const store: RoutingPlannerStore = {
    listTeammates: () => [...options.teammates],
    benchmarkScores: (id) => options.scores?.[id] ?? {},
    semanticMetadata: (id) => {
      semanticMetadataCalls.push(id);
      return {
        id,
        roleTitle: `Role ${id}`,
        capabilities: { CODING: { status: 'SUPPORTED', score: 80 } },
        enabledSkills: [],
        verifiedExperiences: [],
      };
    },
    getParty: () => options.party ?? null,
    humanBridgeSupports: () => {
      bridgeSupportCalls += 1;
      return options.humanBridgeSupports ?? false;
    },
    appendRoutingReceipt: (receipt) => receipts.push(receipt),
  };

  const eligibility = {
    evaluate: (id: string, input: { explicit?: boolean } = {}) => {
      const initial = options.eligibility?.[id] ?? {};
      const probe = probeResults.get(id);
      eligibilityCalls.push({ id, explicit: input.explicit ?? false });
      return {
        eligible: probe && !probe.ok ? false : (initial.eligible ?? true),
        reason: probe && !probe.ok ? 'PROBE_UNAVAILABLE' : (initial.reason ?? 'ELIGIBLE'),
        availability: probedStatuses.get(id) ?? initial.availability ?? 'UNKNOWN',
        runtimeProfileId:
          initial.runtimeProfileId === undefined ? `profile-${id}` : initial.runtimeProfileId,
      };
    },
  } as unknown as Pick<RoutingEligibilityService, 'evaluate'>;

  const availability = {
    prepare: async ({ teammateId, freshProbe }: { teammateId: string; freshProbe?: boolean }) => {
      probeOrder.push(teammateId);
      probeRequests.push({ teammateId, freshProbe });
      activeProbes += 1;
      maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbes);
      await Promise.resolve();
      const result = options.probes?.[teammateId] ?? { ok: true, status: 'AVAILABLE' as const };
      probeResults.set(teammateId, result);
      probedStatuses.set(teammateId, result.status);
      activeProbes -= 1;
      return {
        ok: result.ok,
        availability: { status: result.status },
      };
    },
  } as unknown as Pick<AvailabilityService, 'prepare'>;

  const planner = new RoutingPlanner(store, eligibility, availability, decisionGateway, {
    now: () => '2026-10-01T00:00:00.000Z',
    newId: () => 'routing-receipt-1',
  });

  return {
    planner,
    receipts,
    decisionGateway,
    probeOrder,
    probeRequests,
    semanticMetadataCalls,
    eligibilityCalls,
    get bridgeSupportCalls() {
      return bridgeSupportCalls;
    },
    get maxConcurrentProbes() {
      return maxConcurrentProbes;
    },
  };
}
