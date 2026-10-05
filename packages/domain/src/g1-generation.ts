/** Generation is an execution protocol of MODEL_RUNTIME, never a new executor kind. */
export type GenerationCapability =
  | 'IMAGE_GENERATION'
  | 'IMAGE_EDITING'
  | 'VIDEO_GENERATION'
  | 'SPEECH_GENERATION'
  | 'MUSIC_GENERATION';
export interface GenerationInputRoleDescriptor {
  role: string;
  artifactKinds: string[];
  mimeTypes: string[];
  maxFiles: number;
}
export interface GenerationModelDescriptor {
  modelId: string;
  outputCapability: GenerationCapability;
  executionMode: 'ASYNC_JOB' | 'SYNC';
  featureTags: string[];
  inputRoles: GenerationInputRoleDescriptor[];
  parameterSchema: Record<string, unknown>;
  outputTypes: string[];
  limits: {
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    maxInputFiles: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxOutputs: number;
  };
}
export interface GenerationInputBinding {
  artifactId: string;
  role: string;
}
export interface GenerationTask {
  id: string;
  targetTeammateId: string;
  capability: GenerationCapability;
  requiredFeatures: string[];
  prompt: string;
  inputs: GenerationInputBinding[];
  parameters: Record<string, unknown>;
  expectedOutput: { artifactKind: string; mimeTypes: string[] };
  outputDestination: {
    scope: 'APP_ARTIFACT_STORE' | 'MISSION_WORKSPACE';
    logicalPathHint?: string | null;
  };
  requester: { actorType: 'USER' | 'TEAMMATE' | 'WORKFLOW'; actorId: string | null };
  missionId: string | null;
  runId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  createdAt: string;
}
export type GenerationJobState =
  | 'PENDING'
  | 'SUBMITTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';
export interface GenerationJob {
  id: string;
  generationTaskId: string;
  teammateId: string;
  runtimeProfileId: string;
  providerJobId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  state: GenerationJobState;
  providerStatus: string | null;
  outputArtifactIds: string[];
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface GenerationArtifact {
  id: string;
  jobId: string;
  outputId: string;
  kind: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  metadata: Record<string, number | string | boolean | null>;
  storageScope: GenerationTask['outputDestination']['scope'];
  /** Opaque store key, never an arbitrary Renderer/Provider filesystem path. */
  storageKey: string;
  createdAt: string;
}
export interface GenerationOutputDescriptor {
  id: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  metadata: Record<string, number | string | boolean | null>;
}
export interface GenerationSubmission {
  providerJobId: string | null;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'UNKNOWN';
}
export interface ProviderGenerationJob {
  providerJobId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
  outputs: GenerationOutputDescriptor[];
  errorCode: string | null;
}
const transitions: Record<GenerationJobState, readonly GenerationJobState[]> = {
  PENDING: ['SUBMITTING', 'FAILED', 'CANCELLED'],
  SUBMITTING: ['QUEUED', 'RUNNING', 'UNKNOWN', 'FAILED'],
  QUEUED: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  UNKNOWN: [],
};
export function transitionGenerationJob(
  from: GenerationJobState,
  to: GenerationJobState,
): GenerationJobState {
  if (!transitions[from].includes(to))
    throw new Error(`Invalid GenerationJob transition ${from} -> ${to}`);
  return to;
}
