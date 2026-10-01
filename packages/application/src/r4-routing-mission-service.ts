import { randomUUID } from 'node:crypto';
import type {
  Mission,
  RoutingPlanResult,
  RoutingDecisionReceipt,
  RoutingTaskContext,
  TaskExecutionAssignment,
} from '@cultivation/domain';
import type { Gate3MissionService, Gate3MissionStore } from './gate3-mission-service.js';
import type { Gate5CollaborationService } from './gate5-collaboration-service.js';
import type { Gate5PartyService } from './gate5-party-service.js';
import type { CreateExplicitExternalWorkInput } from './r2-human-bridge-service.js';
import type { RoutingPlanner } from './r4-routing-planner.js';

export type RoutingExternalWorkDraft = Omit<
  CreateExplicitExternalWorkInput,
  'missionId' | 'runId' | 'requesterTeammateId'
>;
export interface RoutingMissionAssignmentStore {
  saveAssignment(value: {
    missionId: string;
    receiptId: string;
    assignment: TaskExecutionAssignment;
    context: RoutingTaskContext;
    externalWorkDraft: RoutingExternalWorkDraft | null;
    createdAt: string;
  }): void;
}
export type RoutingMissionCreationResult =
  | { status: 'CREATED'; mission: Mission; receipt: RoutingDecisionReceipt }
  | Extract<RoutingPlanResult, { status: 'USER_ACTION_REQUIRED' }>;

/** Adapts a generic assignment to the existing Mission/Party execution system. */
export class RoutingMissionService {
  constructor(
    private readonly planner: RoutingPlanner,
    private readonly assignments: RoutingMissionAssignmentStore,
    private readonly store: Gate3MissionStore,
    private readonly solo: Gate3MissionService,
    private readonly partyMissions: Gate5CollaborationService,
    private readonly parties: Gate5PartyService,
    private readonly hasWorkspace: () => boolean,
  ) {}
  async createMission(
    input: {
      title: string;
      context: RoutingTaskContext;
      /** Main-only bounded execution context. Never sent to Jev or persisted in routing receipts. */
      executionObjective?: string;
    },
    onCreated?: (mission: Mission) => void,
  ): Promise<RoutingMissionCreationResult> {
    const plan = await this.planner.plan(input.context);
    if (plan.status !== 'ASSIGNED') return plan;
    if (plan.assignment.kind === 'HUMAN_BRIDGE' && !this.hasWorkspace()) {
      return {
        status: 'USER_ACTION_REQUIRED',
        reason: 'WORKSPACE_REQUIRED',
        actions: ['SELECT_OTHER', 'CANCEL'],
        receipt: plan.receipt,
      };
    }
    const { assignment } = plan;
    const externalWorkDraft: RoutingExternalWorkDraft | null =
      assignment.kind === 'HUMAN_BRIDGE'
        ? this.externalWorkDraft(input.context, input.title, assignment)
        : null;
    const mission = this.store.transaction(() => {
      let created: Mission;
      if (assignment.kind === 'HUMAN_BRIDGE') {
        created = this.solo.createHumanBridgeMission({
          title: input.title,
          objective: input.executionObjective ?? input.context.objective,
          coordinatorTeammateId: assignment.coordinatorTeammateId,
        });
      } else if (assignment.kind === 'SOLO') {
        created = this.solo.create({
          title: input.title,
          objective: input.executionObjective ?? input.context.objective,
          coordinatorTeammateId: assignment.coordinatorTeammateId,
        });
      } else {
        const partyId =
          assignment.partyId ??
          this.parties.createParty({
            name: input.title.slice(0, 100),
            description: '',
            type: 'AD_HOC',
            coordinatorTeammateId: assignment.coordinatorTeammateId,
            memberTeammateIds: assignment.memberTeammateIds,
          }).id;
        created = this.partyMissions.create({
          title: input.title,
          objective: input.executionObjective ?? input.context.objective,
          mode: assignment.mode as 'CONSULTATION' | 'REVIEW' | 'DELEGATION',
          partyId,
        });
      }
      this.assignments.saveAssignment({
        missionId: created.id,
        receiptId: plan.receipt.id,
        assignment,
        context: input.context,
        externalWorkDraft,
        createdAt: new Date().toISOString(),
      });
      const at = new Date().toISOString();
      const payload = {
        receiptId: plan.receipt.id,
        assignmentId: assignment.id,
        kind: assignment.kind,
        coordinatorTeammateId: assignment.coordinatorTeammateId,
        memberTeammateIds: assignment.memberTeammateIds,
        policyVersion: assignment.policyVersion,
        requiredCapabilities: assignment.demand
          .filter((item) => item.required)
          .map((item) => item.dimension),
      };
      this.store.appendMissionEvent({
        id: randomUUID(),
        missionId: created.id,
        runId: null,
        eventType: 'routing.assigned',
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: payload,
        createdAt: at,
      });
      this.store.appendAuditEvent({
        id: randomUUID(),
        action: 'routing.assigned',
        targetType: 'MISSION',
        targetId: created.id,
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: payload,
        createdAt: at,
      });
      // A Workflow Step binding shares this transaction; callback failure rolls back the Mission.
      onCreated?.(created);
      return created;
    });
    return { status: 'CREATED', mission, receipt: plan.receipt };
  }
  private externalWorkDraft(
    context: RoutingTaskContext,
    title: string,
    assignment: TaskExecutionAssignment,
  ): RoutingExternalWorkDraft {
    const output = context.expectedOutputContract ?? {
      name: 'result.txt',
      allowedExtensions: ['.txt'],
      maxSizeBytes: 10 * 1024 * 1024,
    };
    return {
      capability: assignment.demand.find((item) => item.required)!.dimension,
      title,
      prompt: `${context.objective}\n\n交付：${output.name}\n将产物保存到所选 Workspace 的 deliverables 目录，再在本尊待办中提交。\n允许扩展名：${output.allowedExtensions.join('、')}；单文件上限：${output.maxSizeBytes} bytes。\n提交后等待用户验收。`,
      requirements: assignment.demand.filter((item) => item.required).map((item) => item.dimension),
      targetArtifacts: [
        {
          id: 'result',
          name: output.name,
          required: true,
          allowedExtensions: output.allowedExtensions,
          maxSizeBytes: output.maxSizeBytes,
        },
      ],
      targetWorkspacePaths: ['deliverables'],
      acceptanceCriteria: ['用户确认产物满足任务目标与输出要求。'],
      externalAppProfileId: null,
    };
  }
}
