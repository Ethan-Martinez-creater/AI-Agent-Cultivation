import { randomUUID } from 'node:crypto';
import type { Mission } from '@cultivation/domain';
import type { DecisionGateway } from '@cultivation/application/r0-decision';
import {
  DecisionStateBuilder,
  canonicalDecisionJson,
} from '@cultivation/application/r3-decision-state';
import { ShadowDecisionService } from '@cultivation/application/r3-shadow-service';
import type { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import type { HumanBridgeService } from '@cultivation/application/r2-human-bridge-service';
import type {
  DecisionShadowErrorCode,
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate6SqliteRepository,
  R3DecisionReceiptRecord,
  R3SqliteRepository,
} from '@cultivation/persistence';
import { buildR3ShadowCandidates } from './r3-candidate-context.js';
import { R3DecisionConfigController } from './r3-config.js';

const PINNED_MODEL = 'jev-1.13.0';

export class R3ShadowMissionObserver {
  constructor(
    private readonly config: R3DecisionConfigController,
    private readonly repository: R3SqliteRepository,
    private readonly stores: {
      teammates: Gate1SqliteRepository;
      skills: Gate2SqliteRepository;
      experiences: Gate6SqliteRepository;
      capabilities: R1CapabilityService;
      humanBridge: HumanBridgeService;
    },
    private readonly gatewayFactory: (apiKey: string, timeoutMs: number) => DecisionGateway,
  ) {}

  /** Caller intentionally does not await this observer before returning a Mission. */
  async observeMission(mission: Mission): Promise<void> {
    try {
      const provider = this.repository.getDecisionProviderConfig();
      const policy = this.repository.getShadowPolicyConfig();
      if (!provider.enabled || !policy.enabled || provider.mode !== 'SHADOW') return;
      const key = await this.config.resolveKey();
      if (!key) return;

      const candidates = buildR3ShadowCandidates(mission.coordinatorTeammateId, {
        ...this.stores,
        bindingEligibility: this.stores.teammates,
      });
      const builder = new DecisionStateBuilder();
      const gateway = this.gatewayFactory(key, policy.timeoutMs);
      const shadow = new ShadowDecisionService({
        gateway,
        receipts: {
          appendDecisionReceipt: (receipt) =>
            this.repository.appendDecisionReceipt(receipt as R3DecisionReceiptRecord),
        },
        observations: {
          recordDecisionObservation: (observation) => {
            this.repository.appendShadowAttempt({
              id: randomUUID(),
              missionId: mission.id,
              runId: null,
              decisionType: observation.decisionType,
              provider: 'TYPESAFE',
              model: PINNED_MODEL,
              status: observation.status === 'RECORDED' ? 'SUCCESS' : 'ERROR',
              receiptId: observation.receiptId,
              actualAction: observation.actualAction,
              errorCode: observation.fallbackCode as DecisionShadowErrorCode | null,
              latencyMs: observation.latencyMs,
              inputTokens: observation.inputTokens,
              createdAt: observation.createdAt,
            });
          },
        },
        provider: 'TYPESAFE',
        model: PINNED_MODEL,
        modelVersion: PINNED_MODEL,
        policyVersion: policy.policyVersion,
        timeoutMs: policy.timeoutMs,
      });

      const planned = [
        {
          request: builder.buildTaskCapability({ taskSummary: mission.objective }),
          actualAction: null,
        },
        {
          request: builder.buildTeammateFit({
            taskSummary: mission.objective,
            candidates,
            explicitTeammateId: mission.coordinatorTeammateId,
          }),
          actualAction: mission.coordinatorTeammateId,
        },
        {
          request: builder.buildCollaborationNeed({
            taskSummary: mission.objective,
            eligibleCandidateCount: candidates.length,
            selectedMode: mission.mode,
          }),
          actualAction: mission.mode === 'SOLO' ? 'NO' : 'YES',
        },
        {
          request: builder.buildReviewNeed({
            taskSummary: mission.objective,
            selectedMode: mission.mode,
          }),
          actualAction: mission.mode === 'REVIEW' ? 'YES' : 'NO',
        },
      ];
      await Promise.allSettled(
        planned.map(({ request, actualAction }) => {
          if (
            Buffer.byteLength(canonicalDecisionJson(request.state), 'utf8') > policy.maxStateBytes
          ) {
            this.repository.appendShadowAttempt({
              id: randomUUID(),
              missionId: mission.id,
              runId: null,
              decisionType: request.decisionType,
              provider: 'TYPESAFE',
              model: PINNED_MODEL,
              status: 'ERROR',
              receiptId: null,
              actualAction,
              errorCode: 'INVALID_REQUEST' as DecisionShadowErrorCode,
              latencyMs: null,
              inputTokens: null,
              createdAt: new Date().toISOString(),
            });
            return Promise.resolve();
          }
          return shadow.evaluate(request, { missionId: mission.id, actualAction });
        }),
      );
    } catch {
      // This plane cannot alter Mission creation, state, routing, or permissions.
    }
  }
}
