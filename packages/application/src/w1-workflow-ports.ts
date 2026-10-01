import type {
  WorkflowVersion,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowArtifact,
  WorkflowArtifactBinding,
  WorkflowValidationReceipt,
  WorkflowCheckpoint,
  WorkflowEvent,
  WorkflowDecisionFact,
  WorkflowDetail,
  RoutingTaskContext,
  Mission,
  MissionRun,
} from '@cultivation/domain';

export interface WorkflowRepository {
  transaction<T>(fn: () => T): T;
  publishVersion(value: WorkflowVersion): void;
  getVersion(definitionId: string, version: number): WorkflowVersion | null;
  listVersions(): WorkflowVersion[];
  insertRun(value: WorkflowRun): void;
  saveRun(value: WorkflowRun, expectedState: WorkflowRun['state']): boolean;
  insertStep(value: WorkflowStepRun): void;
  saveStep(value: WorkflowStepRun, expectedState: WorkflowStepRun['state']): boolean;
  detail(runId: string): WorkflowDetail | null;
  listRuns(): WorkflowRun[];
  findStepByMissionId(missionId: string): WorkflowStepRun | null;
  appendArtifact(value: WorkflowArtifact): void;
  appendBinding(value: WorkflowArtifactBinding): void;
  appendValidation(value: WorkflowValidationReceipt): void;
  appendDecision(value: WorkflowDecisionFact): void;
  appendCheckpoint(value: WorkflowCheckpoint): void;
  appendEvent(value: WorkflowEvent): void;
}
export interface WorkflowMissionSnapshot {
  mission: Mission;
  run: (MissionRun & { resultText: string | null }) | null;
  outputs: Array<{
    source: 'MISSION' | 'HUMAN_BRIDGE';
    sourceId: string;
    actorId: string;
    kind: WorkflowArtifact['kind'];
    content: string;
    metadata: WorkflowArtifact['metadata'];
  }>;
  uncertainSideEffects: boolean;
}
export interface WorkflowMissionPort {
  /** R4 persists the Mission and binding inside the same synchronous SQLite transaction. */
  create(
    input: { title: string; context: RoutingTaskContext; executionObjective?: string },
    bind: (mission: Mission) => void,
  ): Promise<
    { status: 'CREATED'; mission: Mission } | { status: 'USER_ACTION_REQUIRED'; reason: string }
  >;
  snapshot(missionId: string): WorkflowMissionSnapshot;
  /** Canonical filesystem inspection is an application adapter responsibility, never Renderer input. */
  collectOutputs?(
    missionId: string,
    workspaceRoot: string | null,
  ): Promise<WorkflowMissionSnapshot>;
  workspaceIdentity?(): string | null;
  start(missionId: string): Promise<void>;
  retry(missionId: string): Promise<void>;
  cancel(missionId: string): void;
}
