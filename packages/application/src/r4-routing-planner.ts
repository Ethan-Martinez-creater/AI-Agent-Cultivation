import { createHash, randomUUID } from 'node:crypto';
import type {
  CapabilityDimension,
  RoutingCandidateTrace,
  RoutingDecisionReceipt,
  RoutingPlanResult,
  RoutingTaskContext,
  TaskExecutionAssignment,
  Teammate,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { DecisionGateway, DecisionResult } from './r0-decision.js';
import { DecisionStateBuilder, canonicalDecisionJson } from './r3-decision-state.js';
import type { DecisionCandidateInput } from './r3-decision-state.js';
import type { AvailabilityService, RoutingEligibilityService } from './r3-2-availability.js';
import type { PrepareModelOutcome } from './r3-2-availability.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import { createR4DecisionRequest } from './r4-decision-service.js';

export const R4_ROUTING_POLICY = Object.freeze({
  version: 'r4-controlled-routing-v1',
  semanticCandidateCount: 4,
  maxPartyMembers: 4,
  semanticConfidence: 0.7,
  demandConfidence: 0.7,
  relevantProbability: 0.5,
  minimumDemandWeight: 0.25,
  semanticBonus: 8,
  unstablePenalty: 10,
  maxReceiptCandidates: 128,
});

export interface RoutingPlannerStore {
  listTeammates(): Teammate[];
  benchmarkScores(teammateId: string): Partial<Record<CapabilityDimension, number | null>>;
  semanticMetadata(teammateId: string): DecisionCandidateInput;
  getParty(id: string): {
    id: string;
    status: string;
    coordinatorTeammateId: string;
    memberTeammateIds: string[];
  } | null;
  humanBridgeSupports(teammateId: string, dimensions: CapabilityDimension[]): boolean;
  appendRoutingReceipt(receipt: RoutingDecisionReceipt): void;
}

/** Selection only: no Mission, ModelGateway, Tool or Permission mutation ports. */
export class RoutingPlanner {
  private readonly builder = new DecisionStateBuilder();
  constructor(
    private readonly store: RoutingPlannerStore,
    private readonly eligibility: Pick<RoutingEligibilityService, 'evaluate'>,
    private readonly availability: Pick<AvailabilityService, 'prepare'>,
    private readonly decisions: DecisionGateway,
    private readonly options: { now?: () => string; newId?: () => string } = {},
  ) {}

  async plan(context: RoutingTaskContext): Promise<RoutingPlanResult> {
    this.assertContext(context);
    const teammates = this.store.listTeammates().sort((a, b) => a.id.localeCompare(b.id));
    const explicitTeammate = teammates.find((item) => item.id === context.explicitTeammateId);
    // Validate user intent before IDs, decision calls, probes or durable receipts.
    this.assertExecutionConstraint(context, explicitTeammate);
    const bridgeRequested =
      context.executionConstraint === 'HUMAN_BRIDGE' ||
      explicitTeammate?.executorKind === 'USER_BRIDGE';
    const id = this.options.newId?.() ?? randomUUID();
    const taskRequest = this.builder.buildTaskCapability({ taskSummary: context.objective });
    const receipt: RoutingDecisionReceipt = {
      id,
      assignment: null,
      taskSummary: taskRequest.inputSummary.taskSummary,
      contextHash: createHash('sha256').update(canonicalDecisionJson(context)).digest('hex'),
      demand: [],
      candidates: [],
      decisionSignals: [],
      outcome: 'USER_ACTION_REQUIRED',
      reason: '',
      policyVersion: R4_ROUTING_POLICY.version,
      createdAt: this.options.now?.() ?? new Date().toISOString(),
    };
    const actionRequired = (reason: string): RoutingPlanResult => {
      receipt.reason = reason;
      this.store.appendRoutingReceipt(receipt);
      return {
        status: 'USER_ACTION_REQUIRED',
        reason,
        actions:
          reason.includes('CAPABILITY') || reason.includes('DEMAND')
            ? ['CONFIGURE_CAPABILITY', 'SELECT_OTHER', 'CANCEL']
            : ['RECHECK', 'SELECT_OTHER', 'CANCEL'],
        receipt,
      };
    };
    const assigned = (
      input: Omit<TaskExecutionAssignment, 'id' | 'policyVersion' | 'demand'>,
    ): RoutingPlanResult => {
      const assignment: TaskExecutionAssignment = {
        ...input,
        id,
        demand: receipt.demand,
        policyVersion: R4_ROUTING_POLICY.version,
      };
      receipt.assignment = assignment;
      receipt.outcome = 'ASSIGNED';
      receipt.reason =
        input.kind === 'HUMAN_BRIDGE'
          ? bridgeRequested
            ? 'HUMAN_BRIDGE_SELECTED'
            : 'HUMAN_BRIDGE_FALLBACK'
          : 'SELECTED';
      this.store.appendRoutingReceipt(receipt);
      return { status: 'ASSIGNED', assignment, receipt };
    };
    const explicit = Boolean(context.explicitTeammateId || context.explicitPartyId);
    if (bridgeRequested && !context.requiredCapabilities?.length)
      return actionRequired('HUMAN_BRIDGE_CAPABILITY_REQUIRED');
    if (context.requiredCapabilities?.length) {
      receipt.demand = context.requiredCapabilities.map((dimension) => ({
        dimension,
        weight: 1,
        required: true,
      }));
    } else if (!explicit) {
      const result = await this.decision('TASK_CAPABILITY', taskRequest, receipt);
      if (!result || !Array.isArray(result.answers.demands))
        return actionRequired('TASK_CAPABILITY_UNAVAILABLE');
      const demands = result.answers.demands as Array<{
        dimension: CapabilityDimension;
        probability: number;
        required: boolean;
      }>;
      if (
        demands.some(
          (item) =>
            (result.confidence[`demand.${item.dimension}.required`] ?? 0) <
            R4_ROUTING_POLICY.demandConfidence,
        )
      ) {
        return actionRequired('TASK_DEMAND_LOW_CONFIDENCE');
      }
      receipt.demand = demands
        .filter(
          (item) => item.required || item.probability >= R4_ROUTING_POLICY.relevantProbability,
        )
        .map((item) => ({
          dimension: item.dimension,
          weight: Math.max(item.probability, R4_ROUTING_POLICY.minimumDemandWeight),
          required: item.required,
        }));
      if (!receipt.demand.length || !receipt.demand.some((item) => item.required))
        return actionRequired('TASK_DEMAND_REQUIRES_CONFIRMATION');
    }
    const required = receipt.demand.filter((item) => item.required).map((item) => item.dimension);
    const traceFor = (
      teammateId: string,
      explicitChoice = false,
      allowGenerationParticipant = false,
    ): RoutingCandidateTrace => {
      const evaluated = this.eligibility.evaluate(teammateId, {
        executionProtocol: context.requiredExecutionProtocol,
        allowGenerationParticipant,
        requiredCapabilities: required,
        explicit: explicitChoice,
      });
      const scores = teammates.some((item) => item.id === teammateId)
        ? this.store.benchmarkScores(teammateId)
        : {};
      const validScore = (dimension: CapabilityDimension) =>
        typeof scores[dimension] === 'number' &&
        Number.isFinite(scores[dimension]) &&
        scores[dimension]! >= 0 &&
        scores[dimension]! <= 100;
      const weighted = receipt.demand.filter((item) => validScore(item.dimension));
      const hasRequired = required.every(validScore);
      const benchmarkScore =
        weighted.length && hasRequired
          ? weighted.reduce((sum, item) => sum + scores[item.dimension]! * item.weight, 0) /
            weighted.reduce((sum, item) => sum + item.weight, 0)
          : null;
      const excluded = context.excludedTeammateIds?.includes(teammateId) === true;
      const eligible =
        !excluded && evaluated.eligible && (explicitChoice || benchmarkScore !== null);
      const trace: RoutingCandidateTrace = {
        teammateId,
        runtimeProfileId: evaluated.runtimeProfileId,
        eligible,
        reason: excluded
          ? 'INDEPENDENT_REVIEW_REQUIRED'
          : evaluated.eligible && !eligible
            ? 'BENCHMARK_UNCONFIGURED'
            : evaluated.reason,
        benchmarkScore,
        semanticBonus: 0,
        stabilityPenalty:
          evaluated.availability === 'UNSTABLE' ? R4_ROUTING_POLICY.unstablePenalty : 0,
        rankingScore:
          benchmarkScore === null
            ? null
            : benchmarkScore -
              (evaluated.availability === 'UNSTABLE' ? R4_ROUTING_POLICY.unstablePenalty : 0),
        availability: evaluated.availability,
        probed: false,
      };
      receipt.candidates.push(trace);
      return trace;
    };
    const prepare = async (
      trace: RoutingCandidateTrace,
      explicitChoice = false,
      allowGenerationParticipant = false,
    ): Promise<boolean> => {
      if (!trace.eligible || !trace.runtimeProfileId) return false;
      trace.probed = true;
      let result: PrepareModelOutcome;
      try {
        result = await this.availability.prepare({
          teammateId: trace.teammateId,
          runtimeProfileId: trace.runtimeProfileId,
          freshProbe: true,
        });
      } catch {
        const refreshed = this.eligibility.evaluate(trace.teammateId, {
          executionProtocol: context.requiredExecutionProtocol,
          allowGenerationParticipant,
          requiredCapabilities: required,
          explicit: explicitChoice,
        });
        trace.eligible = false;
        trace.reason = refreshed.eligible ? 'AVAILABILITY_CHECK_FAILED' : refreshed.reason;
        trace.availability = refreshed.availability;
        return false;
      }
      trace.availability = result.availability.status;
      // Re-evaluate after await: archive, Credential rotation or Provider disable cannot race assignment.
      const refreshed = this.eligibility.evaluate(trace.teammateId, {
        executionProtocol: context.requiredExecutionProtocol,
        allowGenerationParticipant,
        requiredCapabilities: required,
        explicit: explicitChoice,
      });
      trace.eligible = result.ok && refreshed.eligible;
      trace.reason = trace.eligible ? 'ELIGIBLE' : refreshed.reason;
      trace.stabilityPenalty =
        trace.availability === 'UNSTABLE' ? R4_ROUTING_POLICY.unstablePenalty : 0;
      trace.rankingScore =
        trace.benchmarkScore === null
          ? null
          : trace.benchmarkScore + trace.semanticBonus - trace.stabilityPenalty;
      return trace.eligible;
    };
    const bridge = (explicitId?: string): RoutingPlanResult => {
      const teammate = teammates.find(
        (item) =>
          (!explicitId || item.id === explicitId) &&
          !context.excludedTeammateIds?.includes(item.id) &&
          item.status === 'ACTIVE' &&
          item.executorKind === 'USER_BRIDGE' &&
          item.systemKind === 'HUMAN_BRIDGE' &&
          item.routingPolicy === 'FALLBACK_ONLY' &&
          item.currentRuntimeProfileId === null,
      );
      if (!teammate || !required.length || !this.store.humanBridgeSupports(teammate.id, required))
        return actionRequired('NO_CAPABLE_EXECUTOR');
      return assigned({
        kind: 'HUMAN_BRIDGE',
        coordinatorTeammateId: teammate.id,
        memberTeammateIds: [],
        partyId: null,
        mode: 'SOLO',
      });
    };
    if (context.explicitTeammateId) {
      const teammate = teammates.find((item) => item.id === context.explicitTeammateId);
      if (teammate?.executorKind === 'USER_BRIDGE') return bridge(teammate.id);
      const trace = traceFor(context.explicitTeammateId, true);
      if (!(await prepare(trace, true))) return actionRequired('EXPLICIT_TEAMMATE_UNAVAILABLE');
      return assigned({
        kind: 'SOLO',
        coordinatorTeammateId: trace.teammateId,
        memberTeammateIds: [],
        partyId: null,
        mode: 'SOLO',
      });
    }
    if (context.explicitPartyId) {
      const party = this.store.getParty(context.explicitPartyId);
      if (
        !party ||
        party.status !== 'ACTIVE' ||
        !party.memberTeammateIds.includes(party.coordinatorTeammateId) ||
        new Set(party.memberTeammateIds).size !== party.memberTeammateIds.length ||
        party.memberTeammateIds.length < 2 ||
        party.memberTeammateIds.length > 4
      )
        return actionRequired('EXPLICIT_PARTY_UNAVAILABLE');
      for (const memberId of party.memberTeammateIds) {
        const teammate = teammates.find((item) => item.id === memberId);
        if (teammate?.executorKind === 'USER_BRIDGE' && memberId !== party.coordinatorTeammateId) {
          if (
            teammate.status !== 'ACTIVE' ||
            (required.length && !this.store.humanBridgeSupports(memberId, required))
          )
            return actionRequired('EXPLICIT_PARTY_UNAVAILABLE');
        } else if (
          !(await prepare(
            traceFor(memberId, true, memberId !== party.coordinatorTeammateId),
            true,
            memberId !== party.coordinatorTeammateId,
          ))
        )
          return actionRequired('EXPLICIT_PARTY_UNAVAILABLE');
      }
      return assigned({
        kind: 'PARTY',
        coordinatorTeammateId: party.coordinatorTeammateId,
        memberTeammateIds: party.memberTeammateIds,
        partyId: party.id,
        mode: context.partyMode ?? 'CONSULTATION',
      });
    }
    if (context.executionConstraint === 'HUMAN_BRIDGE') return bridge();
    const candidates = teammates
      .filter((item) => item.executorKind === 'MODEL_RUNTIME')
      .map((item) => traceFor(item.id))
      .filter((trace) => trace.eligible);
    const rank = (left: RoutingCandidateTrace, right: RoutingCandidateTrace) =>
      (right.rankingScore ?? -Infinity) - (left.rankingScore ?? -Infinity) ||
      left.teammateId.localeCompare(right.teammateId);
    candidates.sort(rank);
    const top = candidates.slice(0, R4_ROUTING_POLICY.semanticCandidateCount);
    if (top.length) {
      const result = await this.decision(
        'TEAMMATE_FIT',
        this.builder.buildTeammateFit({
          taskSummary: context.objective,
          candidates: top.map((candidate) => this.store.semanticMetadata(candidate.teammateId)),
        }),
        receipt,
      );
      const selected = top.find((candidate) => candidate.teammateId === result?.selectedAction);
      if (selected && (result?.confidence.teammate ?? 0) >= R4_ROUTING_POLICY.semanticConfidence) {
        selected.semanticBonus = R4_ROUTING_POLICY.semanticBonus;
        selected.rankingScore! += R4_ROUTING_POLICY.semanticBonus;
      }
    }
    candidates.sort(rank);
    let wantsParty = context.executionConstraint === 'PARTY';
    if (context.executionConstraint !== 'SOLO' && candidates.length >= 2 && !wantsParty) {
      const collaboration = await this.decision(
        'COLLABORATION_NEED',
        this.builder.buildCollaborationNeed({
          taskSummary: context.objective,
          eligibleCandidateCount: candidates.length,
        }),
        receipt,
      );
      wantsParty =
        collaboration?.answers.collaboration === 'YES' &&
        (collaboration.confidence.collaboration ?? 0) >= R4_ROUTING_POLICY.semanticConfidence;
    }
    const checked = new Set<string>();
    const viable: RoutingCandidateTrace[] = [];
    const takeNext = async (): Promise<RoutingCandidateTrace | null> => {
      while (true) {
        candidates.sort(rank);
        const candidate = candidates.find((item) => !checked.has(item.teammateId));
        if (!candidate) return viable[0] ?? null;
        checked.add(candidate.teammateId);
        if (!(await prepare(candidate))) continue;
        viable.push(candidate);
        viable.sort(rank);
        // A newly discovered UNSTABLE status may change ordering; check the next better candidate only.
        const untestedBest = candidates.find((item) => !checked.has(item.teammateId));
        if (untestedBest && rank(untestedBest, viable[0]!) < 0) continue;
        return viable[0]!;
      }
    };
    const coordinator = await takeNext();
    if (!coordinator) {
      if (context.executionConstraint === 'SOLO')
        return actionRequired('SOLO_REQUIRES_MODEL_EXECUTOR');
      if (context.executionConstraint === 'PARTY')
        return actionRequired('PARTY_REQUIRES_TWO_EXECUTORS');
      return bridge();
    }
    if (wantsParty) {
      let member = viable.find((item) => item.teammateId !== coordinator.teammateId);
      for (const candidate of candidates.filter((item) => !checked.has(item.teammateId))) {
        if (member) break;
        checked.add(candidate.teammateId);
        if (await prepare(candidate)) member = candidate;
      }
      if (member)
        return assigned({
          kind: 'PARTY',
          coordinatorTeammateId: coordinator.teammateId,
          memberTeammateIds: [coordinator.teammateId, member.teammateId],
          partyId: null,
          mode: context.partyMode ?? 'CONSULTATION',
        });
      if (context.executionConstraint === 'PARTY')
        return actionRequired('PARTY_REQUIRES_TWO_EXECUTORS');
    }
    return assigned({
      kind: 'SOLO',
      coordinatorTeammateId: coordinator.teammateId,
      memberTeammateIds: [],
      partyId: null,
      mode: 'SOLO',
    });
  }

  private async decision(
    type: string,
    request: Parameters<DecisionGateway['evaluate']>[0],
    receipt: RoutingDecisionReceipt,
  ): Promise<DecisionResult | null> {
    const boundedRequest = createR4DecisionRequest(request);
    const metadata = {
      requestHash: boundedRequest.stateHash,
      questionVersion: boundedRequest.questionVersion,
      policyVersion: boundedRequest.policyVersion,
    };
    const safeNumber = (value: number | null | undefined) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    try {
      const result = await this.decisions.evaluate(boundedRequest);
      if (result.errorCode) {
        receipt.decisionSignals.push({
          ...metadata,
          type,
          status: 'UNAVAILABLE',
          recommendation: null,
          confidence: null,
          errorCode: result.errorCode,
          inputTokens: safeNumber(result.inputTokens),
          latencyMs: safeNumber(result.latencyMs),
        });
        return null;
      }
      const confidence =
        type === 'TASK_CAPABILITY'
          ? Math.min(...Object.values(result.confidence))
          : (result.confidence[type === 'TEAMMATE_FIT' ? 'teammate' : 'collaboration'] ?? 0);
      const accepted =
        confidence >= R4_ROUTING_POLICY.semanticConfidence &&
        (type === 'TASK_CAPABILITY'
          ? Array.isArray(result.answers.demands) &&
            result.answers.demands.some((item: { required?: boolean }) => item.required === true)
          : type === 'TEAMMATE_FIT'
            ? result.selectedAction !== 'NONE' && result.selectedAction !== null
            : result.answers.collaboration === 'YES' || result.answers.collaboration === 'NO');
      receipt.decisionSignals.push({
        ...metadata,
        type,
        status: accepted ? 'ACCEPTED' : 'IGNORED',
        recommendation: result.selectedAction,
        confidence: Number.isFinite(confidence) ? confidence : null,
        errorCode: null,
        inputTokens: safeNumber(result.inputTokens),
        latencyMs: safeNumber(result.latencyMs),
      });
      return result;
    } catch {
      receipt.decisionSignals.push({
        ...metadata,
        type,
        status: 'UNAVAILABLE',
        recommendation: null,
        confidence: null,
        errorCode: 'PROVIDER_UNAVAILABLE',
        inputTokens: null,
        latencyMs: null,
      });
      return null;
    }
  }

  private assertExecutionConstraint(
    context: RoutingTaskContext,
    explicitTeammate: Teammate | undefined,
  ): void {
    if (!context.executionConstraint) return;
    const expected = context.explicitPartyId
      ? 'PARTY'
      : context.explicitTeammateId
        ? explicitTeammate?.executorKind === 'USER_BRIDGE'
          ? 'HUMAN_BRIDGE'
          : 'SOLO'
        : null;
    if (expected && context.executionConstraint !== expected)
      throw new DomainError('INVALID_INPUT', '执行约束与显式指定对象冲突');
  }

  private assertContext(context: RoutingTaskContext): void {
    const fields = [
      'objective',
      'requiredExecutionProtocol',
      'requiredCapabilities',
      'executionConstraint',
      'explicitTeammateId',
      'explicitPartyId',
      'excludedTeammateIds',
      'partyMode',
      'inputArtifactMetadata',
      'expectedOutputContract',
      'executionContext',
    ];
    if (Object.keys(context).some((field) => !fields.includes(field)))
      throw new DomainError('INVALID_INPUT', '任务上下文字段无效');
    if (
      context.requiredExecutionProtocol !== undefined &&
      !['LANGUAGE', 'GENERATION'].includes(context.requiredExecutionProtocol)
    )
      throw new DomainError('INVALID_INPUT', '执行协议约束无效');
    if (
      !context.objective.trim() ||
      context.objective.length > 8000 ||
      (context.explicitPartyId && context.explicitTeammateId)
    )
      throw new DomainError('INVALID_INPUT', '任务或执行选择无效');
    const dimensions = context.requiredCapabilities ?? [];
    if (
      context.excludedTeammateIds !== undefined &&
      (!Array.isArray(context.excludedTeammateIds) ||
        context.excludedTeammateIds.length > 128 ||
        context.excludedTeammateIds.some((id) => typeof id !== 'string' || !id || id.length > 256))
    )
      throw new DomainError('INVALID_INPUT', '排除的执行者无效');
    const output = context.expectedOutputContract;
    if (
      output &&
      (!output.name.trim() ||
        output.name.length > 128 ||
        /[\\/:]/.test(output.name) ||
        [...output.name].some((character) => character.charCodeAt(0) < 32) ||
        !Number.isInteger(output.maxSizeBytes) ||
        output.maxSizeBytes < 1 ||
        output.maxSizeBytes > 100 * 1024 * 1024 ||
        !output.allowedExtensions.length ||
        output.allowedExtensions.length > 16 ||
        output.allowedExtensions.some((extension) => !/^\.[a-z0-9]{1,12}$/.test(extension)))
    )
      throw new DomainError('INVALID_INPUT', '产物交付约定无效');
    if (
      context.executionConstraint &&
      !['AUTO', 'SOLO', 'PARTY', 'HUMAN_BRIDGE'].includes(context.executionConstraint)
    )
      throw new DomainError('INVALID_INPUT', '执行约束无效');
    if (
      dimensions.length > 14 ||
      new Set(dimensions).size !== dimensions.length ||
      dimensions.some((dimension) => !CAPABILITY_DIMENSIONS.includes(dimension))
    )
      throw new DomainError('INVALID_INPUT', '能力要求无效');
    if (this.store.listTeammates().length > R4_ROUTING_POLICY.maxReceiptCandidates)
      throw new DomainError('ROUTING_LIMIT', '道友数量超过本版本的路由上限');
  }
}
