/** Public preload bridge used by the frozen packaged application. */
interface CultivationBridge {
  desktop: { close(): Promise<void> };
  tools: {
    chooseWorkspace(): Promise<{ rootPath: string }>;
    saveMcpServer(input: Record<string, unknown>): Promise<{ id: string }>;
    refreshMcpServer(id: string): Promise<{
      status: string;
      tools: Array<{ id: string; toolName: string }>;
    }>;
  };
  routing: { config(): Promise<unknown> };
  r3: { getConfig(): Promise<unknown> };
  r2: { setCapability(input: { dimension: string; enabled: boolean }): Promise<void> };
  providers: {
    create(input: Record<string, unknown>): Promise<{ id: string }>;
  };
  runtimes: {
    create(input: Record<string, unknown>): Promise<{ id: string }>;
  };
  teammates: {
    create(input: Record<string, unknown>): Promise<{
      id: string;
      currentRuntimeProfileId: string | null;
    }>;
  };
  capability: { saveBenchmark(input: Record<string, unknown>): Promise<void> };
  availability: {
    recheck(id: string): Promise<{ status: string }>;
  };
  workflows: {
    versions(): Promise<WorkflowVersion[]>;
    create(input: WorkflowCreateInput): Promise<WorkflowDetail>;
    detail(id: string): Promise<WorkflowDetail>;
    advance(id: string): Promise<WorkflowDetail>;
  };
  missions: {
    detail(id: string): Promise<{ approvals: MissionApproval[] }>;
    resolveApproval(input: {
      approvalId: string;
      decision: 'ALLOW_MISSION';
    }): Promise<unknown>;
  };
}

interface WorkflowVersion {
  definition: { id: string };
  steps: Array<{ routing: { requiredCapabilities?: string[] } }>;
}

interface WorkflowCreateInput {
  definitionId: string;
  version: number;
  inputs: {
    objective: string;
    workspaceRoot: string;
    targetArea: string[];
    allowedToolScope: string[];
  };
}

interface WorkflowRunView {
  id: string;
  definitionId: string;
  definitionVersion: number;
  state: string;
  waitReason?: string | null;
}

interface WorkflowStepView {
  stepId: string;
  missionId?: string | null;
  missionRunId?: string | null;
  state: string;
}

interface WorkflowDetail {
  run: WorkflowRunView;
  steps: WorkflowStepView[];
}

interface MissionApproval {
  id: string;
  capability: string;
  state: string;
}

interface FixtureSetup {
  actors: Array<{ id: string; name: string }>;
  serverId: string;
  toolId: string;
  mcpStatus: string;
  routingConfig: unknown;
  r3Config: unknown;
  availability: Array<{
    teammateId: string;
    observations: Array<{ status: string }>;
    latest: { status: string };
  }>;
  modelGateway: string;
}

interface Window {
  /** Versioned renderer-to-Main preload IPC exposed by the packaged build. */
  cultivation: CultivationBridge;
}
