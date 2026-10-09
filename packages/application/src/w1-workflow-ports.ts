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
  WorkflowFinalValidation,
  WorkflowStepDefinition,
  StepOperationReceipt,
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
  appendFinalValidation(value: WorkflowFinalValidation): void;
  /** Independent import confirmation/source validation; never substitutes for a Mission fact. */
  verifyImportedArtifact?(artifact: WorkflowArtifact): boolean;
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
  prepareExecution?(
    definition: WorkflowStepDefinition,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
  ): Promise<{ reason: string } | { routing?: Partial<RoutingTaskContext> }>;
  /** R4 persists the Mission and binding inside the same synchronous SQLite transaction. */
  create(
    input: { title: string; context: RoutingTaskContext; executionObjective?: string },
    bind: (mission: Mission) => void,
  ): Promise<
    { status: 'CREATED'; mission: Mission } | { status: 'USER_ACTION_REQUIRED'; reason: string }
  >;
  snapshot(missionId: string): WorkflowMissionSnapshot;
  /** Re-check accepted delivery facts independently of the derived Workflow ledger. */
  hasAcceptedArtifactProvenance?(artifact: WorkflowArtifact): boolean;
  /** Canonical filesystem inspection is an application adapter responsibility, never Renderer input. */
  collectOutputs?(
    missionId: string,
    workspaceRoot: string | null,
    definition?: WorkflowStepDefinition,
    context?: WorkflowStepExecutionContext,
  ): Promise<WorkflowMissionSnapshot>;
  /** Canonical bounded metadata inspection; this port never executes an operation. */
  captureOperation?(
    definition: WorkflowStepDefinition,
    workspaceRoot: string | null,
    context?: WorkflowStepExecutionContext,
  ): Promise<StepOperationReceipt['manifest']>;
  verifyOperation?(
    receipt: StepOperationReceipt,
    definition: WorkflowStepDefinition,
    snapshot: WorkflowMissionSnapshot,
    workspaceRoot: string | null,
    context?: WorkflowStepExecutionContext,
  ): Promise<{
    verified: boolean;
    manifest: StepOperationReceipt['manifest'];
    externalReference?: string;
  }>;
  workspaceIdentity?(): string | null;
  start(missionId: string): Promise<void>;
  retry(missionId: string): Promise<void>;
  cancel(missionId: string): void;
}

export interface WorkflowStepExecutionContext {
  workflowRunId: string;
  stepRunId: string;
}
