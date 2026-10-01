import { DomainError } from '@cultivation/shared';
import type {
  Gate3MissionService,
  Gate3MissionStore,
} from '@cultivation/application/gate3-mission-service';
import type { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import type {
  ExternalWorkService,
  WorkflowMissionPort,
  WorkflowMissionSnapshot,
  RoutingMissionService,
} from '@cultivation/application';
import { FileWorkspace } from './file-workspace.js';

/** Shares R4/Mission authority; it has no ModelGateway, ToolRuntime or permission shortcuts. */
export class WorkflowMissionAdapter implements WorkflowMissionPort {
  constructor(
    private readonly routing: RoutingMissionService,
    private readonly store: Gate3MissionStore,
    private readonly solo: Gate3MissionService,
    private readonly party: Gate5CollaborationService,
    private readonly externalWork: ExternalWorkService,
    private readonly workspaceRoot: () => string | null,
  ) {}
  async create(
    input: Parameters<WorkflowMissionPort['create']>[0],
    bind: Parameters<WorkflowMissionPort['create']>[1],
  ): Promise<Awaited<ReturnType<WorkflowMissionPort['create']>>> {
    const result = await this.routing.createMission(input, bind);
    return result.status === 'CREATED'
      ? { status: result.status, mission: result.mission }
      : { status: result.status, reason: result.reason };
  }
  snapshot(id: string): WorkflowMissionSnapshot {
    const mission = this.store.getMission(id);
    if (!mission) throw new DomainError('NOT_FOUND', 'Workflow 绑定的 Mission 不存在');
    const run = this.store.listRuns(id).at(-1) ?? null;
    const events = this.store.listMissionEvents(id).filter((e) => e.runId === run?.id);
    return {
      mission,
      run,
      outputs:
        run?.status === 'COMPLETED' && run.resultText !== null
          ? [
              {
                source: 'MISSION',
                sourceId: run.id,
                actorId: mission.coordinatorTeammateId,
                kind: 'TEXT',
                content: run.resultText,
                metadata: {},
              },
            ]
          : [],
      uncertainSideEffects:
        events.some((e) =>
          ['tool.execution_started', 'tool.call_started', 'tool.proposed', 'tool.result'].includes(
            e.eventType,
          ),
        ) && run?.status !== 'COMPLETED',
    };
  }
  workspaceIdentity(): string | null {
    return this.workspaceRoot();
  }
  async collectOutputs(
    id: string,
    boundWorkspaceRoot: string | null,
  ): Promise<WorkflowMissionSnapshot> {
    const snapshot = this.snapshot(id);
    if (!snapshot.run || snapshot.run.status !== 'COMPLETED') return snapshot;
    const requests = this.externalWork
      .listExternalWorkRequests(id, snapshot.run.id)
      .filter((r) => r.state === 'ACCEPTED');
    for (const request of requests) {
      const detail = this.externalWork.getExternalWorkRequest(request.id)!;
      const root = this.workspaceRoot();
      if (!root || root !== boundWorkspaceRoot)
        throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', '请恢复交付时使用的 Workspace');
      const workspace = await FileWorkspace.open(root);
      for (const artifact of detail.artifacts.filter(
        (a) => a.submittedAt === request.submittedAt,
      )) {
        const inspected = await workspace.inspectArtifact(
          artifact.path,
          artifact.sizeBytes || 1,
          true,
        );
        if (
          inspected.sizeBytes !== artifact.sizeBytes ||
          inspected.fileName !== artifact.fileName ||
          inspected.extension !== artifact.extension
        )
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '外部产物已改变，请重新确认');
        snapshot.outputs.push({
          source: 'HUMAN_BRIDGE',
          sourceId: artifact.id,
          actorId: request.assigneeTeammateId,
          kind: 'FILE',
          content: '',
          metadata: {
            path: artifact.path,
            fileName: artifact.fileName,
            extension: artifact.extension,
            sizeBytes: artifact.sizeBytes,
            targetArtifactId: String(artifact.metadataJson.targetArtifactId),
            contentHash: inspected.contentHash!,
          },
        });
      }
    }
    return snapshot;
  }
  async start(id: string): Promise<void> {
    const mission = this.snapshot(id).mission;
    if (mission.mode === 'SOLO') {
      if (mission.state === 'DRAFT') this.solo.ready(id);
      await this.solo.start({ missionId: id, approvalFixture: false });
    } else {
      if (mission.state === 'DRAFT') this.party.ready(id);
      await this.party.start(id);
    }
  }
  async retry(id: string): Promise<void> {
    const mission = this.snapshot(id).mission;
    if (mission.mode === 'SOLO') await this.solo.retry({ missionId: id, approvalFixture: false });
    else await this.party.retry(id);
  }
  cancel(id: string): void {
    if (this.snapshot(id).mission.mode === 'SOLO') this.solo.cancel(id);
    else this.party.cancel(id);
  }
}
