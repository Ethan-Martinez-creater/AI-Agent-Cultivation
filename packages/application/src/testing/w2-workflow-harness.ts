import type Database from 'better-sqlite3';
import type {
  ArtifactContract,
  WorkflowArtifactKind,
  WorkflowArtifactSpec,
  WorkflowStepDefinition,
  WorkflowVersion,
} from '@cultivation/domain';
import type { Mission } from '@cultivation/domain';
import type {
  WorkflowMissionPort,
  WorkflowMissionSnapshot,
  WorkflowRepository,
} from '../w1-workflow-ports.js';

/** Shared W2 integration fixtures are always USER data; this is not an official template. */
export const W2_TEST_FIXTURE_SOURCE = 'USER' as const;
export const W2_TEST_FIXTURE_LABEL = 'TEST_ONLY';
export const W2_FIXTURE_NOW = '2026-10-01T00:00:00.000Z';
export const W2_FIXTURE_HASH = 'a'.repeat(64);

export interface W2FixtureClock {
  now(): string;
  id(): `${string}-${string}-${string}-${string}-${string}`;
}

export function createW2FixtureClock(prefix = 'w2-test'): W2FixtureClock {
  let sequence = 0;
  const safePrefix = prefix.replace(/-/g, '_');
  return {
    now: () => W2_FIXTURE_NOW,
    id: () =>
      `${safePrefix}-${String(++sequence).padStart(12, '0')}-4000-8000-${String(sequence).padStart(12, '0')}`,
  };
}

export function createW2FixtureContract(
  contractVersion = '1',
  options: {
    contractId?: string;
    kind?: ArtifactContract['kind'];
    validator?: ArtifactContract['validator'];
    validatorVersion?: string;
    maxSizeBytes?: number;
  } = {},
): ArtifactContract {
  const kind = options.kind ?? 'JSON';
  const validator = options.validator ?? defaultValidator(kind);
  return {
    contractId: options.contractId ?? 'test.output',
    contractVersion,
    kind,
    validatorVersion: options.validatorVersion ?? 'w2-deterministic-v1',
    maxSizeBytes: options.maxSizeBytes ?? 16_384,
    validator,
  };
}

function defaultValidator(kind: ArtifactContract['kind']): ArtifactContract['validator'] {
  switch (kind) {
    case 'JSON':
      return {
        type: 'JSON_SCHEMA',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 0, maxLength: 4000 },
            verdict: { type: 'enum', values: ['PASS', 'REVISE', 'FAIL'] },
            revisionCode: { type: 'string', minLength: 1, maxLength: 128 },
            findings: {
              type: 'array',
              items: { type: 'string', minLength: 0, maxLength: 1000 },
              minItems: 0,
              maxItems: 20,
            },
            evidence: {
              type: 'array',
              items: { type: 'string', minLength: 0, maxLength: 1000 },
              minItems: 0,
              maxItems: 20,
            },
            summary: { type: 'string', minLength: 0, maxLength: 2000 },
            reviewedArtifactIds: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 128 },
              minItems: 0,
              maxItems: 12,
            },
          },
          required: [],
        },
      };
    case 'TEXT':
      return { type: 'TEXT_RULES', minLength: 1, requiredSections: [] };
    case 'FILE':
      return {
        type: 'FILE_METADATA',
        allowedExtensions: ['.txt'],
        allowedMediaTypes: [],
        requireContentHash: true,
      };
    case 'DIRECTORY':
      return { type: 'DIRECTORY_MANIFEST', maxEntries: 16, requireHashes: true };
    case 'WORKSPACE':
      return {
        type: 'WORKSPACE_MANIFEST',
        maxEntries: 16,
        allowedPaths: ['docs/README.md'],
        requireBeforeHash: true,
      };
  }
}

export function createW2FixtureArtifactSpec(
  contract: ArtifactContract,
  key = 'result',
): WorkflowArtifactSpec {
  const kind: WorkflowArtifactKind = contract.kind === 'WORKSPACE' ? 'DIRECTORY' : contract.kind;
  return {
    key,
    kind,
    required: true,
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    maxSizeBytes: contract.maxSizeBytes,
    description: 'Shared TEST_ONLY fixture output',
    validator: {
      type: 'REGISTRY',
      contractId: contract.contractId,
      contractVersion: contract.contractVersion,
    },
  };
}

export function createW1FixtureTextSpec(key = 'result'): WorkflowArtifactSpec {
  return {
    key,
    kind: 'TEXT',
    required: true,
    contractId: 'legacy.test.output',
    contractVersion: '1',
    maxSizeBytes: 4096,
    description: 'Legacy W1 compatibility fixture output',
    validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
  };
}

export function createW2FixtureStep(
  id: string,
  overrides: Partial<WorkflowStepDefinition> = {},
): WorkflowStepDefinition {
  return {
    id,
    type: 'TASK',
    title: 'TEST_ONLY ' + id,
    objective: 'Complete the TEST_ONLY fixture step: ' + id,
    routing: {},
    inputs: [],
    outputs: [],
    maxAttempts: 3,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
    ...overrides,
  };
}

export function createW2FixtureVersion(options: {
  definitionId: string;
  version: number;
  steps: WorkflowStepDefinition[];
  edges?: WorkflowVersion['edges'];
  contracts?: ArtifactContract[];
  revisionGroups?: WorkflowVersion['revisionGroups'];
}): WorkflowVersion {
  return {
    definition: {
      id: options.definitionId,
      name: 'TEST_ONLY workflow fixture',
      description: 'Shared integration-test fixture; not an official Workflow template.',
      category: 'test-only',
      source: W2_TEST_FIXTURE_SOURCE,
    },
    version: options.version,
    ...(options.contracts === undefined ? {} : { contractManifest: options.contracts }),
    ...(options.revisionGroups === undefined ? {} : { revisionGroups: options.revisionGroups }),
    entryStepId: options.steps[0]!.id,
    steps: options.steps,
    edges: options.edges ?? [],
    referenceBasis: [],
    createdAt: W2_FIXTURE_NOW,
  };
}

export interface W2FixtureOutput {
  kind: WorkflowArtifactKind;
  content: string;
  metadata?: Record<string, string | number>;
}

export interface W2FixtureMissionResult {
  resultText: string;
  outputs?: W2FixtureOutput[];
  uncertainSideEffects?: boolean;
}

export interface W2FixtureMissionRequest {
  title: string;
  context: Parameters<WorkflowMissionPort['create']>[0]['context'];
  executionObjective?: string;
}

export interface W2FixtureOutputFactoryInput {
  step: WorkflowStepDefinition;
  request: W2FixtureMissionRequest;
  missionId: string;
  missionRunId: string;
}

export interface W2FixtureMissionOptions {
  db: Database.Database;
  store: WorkflowRepository;
  version: WorkflowVersion;
  missionIdPrefix?: string;
  startMode?: 'COMPLETE' | 'WAIT_EXTERNAL';
  outputForStep?: (input: W2FixtureOutputFactoryInput) => W2FixtureMissionResult;
  captureOperation?: WorkflowMissionPort['captureOperation'];
  verifyOperation?: WorkflowMissionPort['verifyOperation'];
  workspaceRoot?: string | null;
}

export interface W2FixtureMissionPort extends WorkflowMissionPort {
  readonly calls: {
    create: number;
    start: number;
    retry: number;
    verifyOperation: number;
  };
  missionIdForStep(workflowRunId: string, stepId: string): string | null;
  completeMission(missionId: string, result: W2FixtureMissionResult): void;
}

/** A local SQLite-backed adapter fixture; it records Mission facts but runs no model or tool. */
export function createW2FixtureMissionPort(options: W2FixtureMissionOptions): W2FixtureMissionPort {
  const coordinatorId = 'w2-test-coordinator';
  options.db
    .prepare(
      `INSERT OR IGNORE INTO teammates (id, name, created_at, updated_at)
       VALUES (?, 'TEST_ONLY Workflow Coordinator', ?, ?)`,
    )
    .run(coordinatorId, W2_FIXTURE_NOW, W2_FIXTURE_NOW);

  const snapshots = new Map<string, WorkflowMissionSnapshot>();
  const requests = new Map<string, W2FixtureMissionRequest>();
  const stepByMission = new Map<string, WorkflowStepDefinition>();
  const counters = { create: 0, start: 0, retry: 0, verifyOperation: 0 };

  const completeMission = (missionId: string, result: W2FixtureMissionResult): void => {
    const current = snapshots.get(missionId);
    const request = requests.get(missionId);
    const step = stepByMission.get(missionId);
    if (!current || !request || !step) throw new Error('Unknown TEST_ONLY fixture Mission');
    const runId = current.run?.id ?? missionId + '-run-1';
    if (!current.run) {
      options.db
        .prepare(
          `INSERT INTO mission_runs
           (id, mission_id, attempt, status, started_at, ended_at, result_text)
           VALUES (?, ?, 1, 'RUNNING', ?, NULL, NULL)`,
        )
        .run(runId, missionId, W2_FIXTURE_NOW);
    }
    options.db
      .prepare(
        `UPDATE mission_runs
         SET status = 'COMPLETED', ended_at = ?, error_code = NULL, error_message = NULL, result_text = ?
         WHERE id = ?`,
      )
      .run(W2_FIXTURE_NOW, result.resultText, runId);
    options.db
      .prepare(
        `UPDATE missions SET state = 'COMPLETED', updated_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(W2_FIXTURE_NOW, W2_FIXTURE_NOW, missionId);

    const outputs = (result.outputs ?? []).map((output) => ({
      source: 'MISSION' as const,
      sourceId: runId,
      actorId: coordinatorId,
      kind: output.kind,
      content: output.content,
      metadata: output.metadata ?? {},
    }));
    const mission = {
      ...current.mission,
      state: 'COMPLETED',
      updatedAt: W2_FIXTURE_NOW,
      completedAt: W2_FIXTURE_NOW,
    } as Mission;
    snapshots.set(missionId, {
      mission,
      run: {
        id: runId,
        missionId,
        attempt: 1,
        status: 'COMPLETED',
        startedAt: W2_FIXTURE_NOW,
        endedAt: W2_FIXTURE_NOW,
        errorCode: null,
        errorMessage: null,
        resultText: result.resultText,
      },
      outputs,
      uncertainSideEffects: result.uncertainSideEffects ?? false,
    });
  };

  return {
    calls: counters,
    async create(input, bind) {
      counters.create += 1;
      const request = input as W2FixtureMissionRequest;
      const executionContext = request.context.executionContext;
      const workflowRunId = executionContext?.executionId;
      const stepId = executionContext?.stepId;
      if (!workflowRunId || !stepId) throw new Error('Fixture Mission is missing Workflow context');
      const stepRun = options.store.detail(workflowRunId)?.steps.find((item) => item.id === stepId);
      const step = options.version.steps.find((item) => item.id === stepRun?.stepId);
      if (!step) throw new Error('Fixture Mission references an unknown TEST_ONLY StepRun');
      const missionId =
        (options.missionIdPrefix ?? 'w2-test-mission') +
        '-' +
        String(counters.create).padStart(4, '0');
      const mission: Mission = {
        id: missionId,
        title: input.title,
        objective: input.executionObjective ?? input.title,
        initiatorType: 'USER',
        initiatorId: 'w2-test-user',
        coordinatorTeammateId: coordinatorId,
        partyId: null,
        mode: 'SOLO',
        state: 'DRAFT',
        createdAt: W2_FIXTURE_NOW,
        updatedAt: W2_FIXTURE_NOW,
        completedAt: null,
      } as Mission;
      options.store.transaction(() => {
        options.db
          .prepare(
            `INSERT INTO missions
             (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
              mode, state, created_at, updated_at)
             VALUES (?, ?, ?, 'USER', 'w2-test-user', ?, 'SOLO', 'DRAFT', ?, ?)`,
          )
          .run(
            mission.id,
            mission.title,
            mission.objective,
            coordinatorId,
            W2_FIXTURE_NOW,
            W2_FIXTURE_NOW,
          );
        bind(mission);
      });
      requests.set(missionId, request);
      stepByMission.set(missionId, step);
      snapshots.set(missionId, {
        mission,
        run: null,
        outputs: [],
        uncertainSideEffects: false,
      });
      return { status: 'CREATED', mission };
    },
    snapshot(missionId) {
      const value = snapshots.get(missionId);
      if (!value) throw new Error('TEST_ONLY Mission has not been created');
      return value;
    },
    async start(missionId) {
      counters.start += 1;
      const current = snapshots.get(missionId);
      const request = requests.get(missionId);
      const step = stepByMission.get(missionId);
      if (!current || !request || !step) throw new Error('Unknown TEST_ONLY fixture Mission');
      const runId = missionId + '-run-1';
      options.db
        .prepare(
          `INSERT INTO mission_runs
           (id, mission_id, attempt, status, started_at, ended_at, result_text)
           VALUES (?, ?, 1, 'RUNNING', ?, NULL, NULL)`,
        )
        .run(runId, missionId, W2_FIXTURE_NOW);
      if ((options.startMode ?? 'COMPLETE') === 'WAIT_EXTERNAL') {
        options.db
          .prepare(
            `UPDATE missions SET state = 'WAITING_EXTERNAL_WORK', updated_at = ? WHERE id = ?`,
          )
          .run(W2_FIXTURE_NOW, missionId);
        snapshots.set(missionId, {
          ...current,
          mission: {
            ...current.mission,
            state: 'WAITING_EXTERNAL_WORK',
            updatedAt: W2_FIXTURE_NOW,
          } as Mission,
          run: {
            id: runId,
            missionId,
            attempt: 1,
            status: 'RUNNING',
            startedAt: W2_FIXTURE_NOW,
            endedAt: null,
            errorCode: null,
            errorMessage: null,
            resultText: null,
          },
        });
        return;
      }
      options.db
        .prepare(`UPDATE missions SET state = 'RUNNING', updated_at = ? WHERE id = ?`)
        .run(W2_FIXTURE_NOW, missionId);
      snapshots.set(missionId, {
        ...current,
        mission: { ...current.mission, state: 'RUNNING', updatedAt: W2_FIXTURE_NOW } as Mission,
        run: {
          id: runId,
          missionId,
          attempt: 1,
          status: 'RUNNING',
          startedAt: W2_FIXTURE_NOW,
          endedAt: null,
          errorCode: null,
          errorMessage: null,
          resultText: null,
        },
      });
      const result = options.outputForStep?.({
        step,
        request,
        missionId,
        missionRunId: runId,
      }) ?? { resultText: 'TEST_ONLY completed', outputs: [] };
      completeMission(missionId, result);
    },
    async retry() {
      counters.retry += 1;
    },
    cancel(missionId) {
      const current = snapshots.get(missionId);
      if (!current) return;
      options.db
        .prepare(`UPDATE missions SET state = 'CANCELLED', updated_at = ? WHERE id = ?`)
        .run(W2_FIXTURE_NOW, missionId);
      snapshots.set(missionId, {
        ...current,
        mission: { ...current.mission, state: 'CANCELLED', updatedAt: W2_FIXTURE_NOW } as Mission,
      });
    },
    async captureOperation(definition, workspaceRoot) {
      if (options.captureOperation) return options.captureOperation(definition, workspaceRoot);
      return (definition.effectPaths ?? []).map((relativePath) => ({ relativePath }));
    },
    async verifyOperation(receipt, definition, snapshot, workspaceRoot) {
      counters.verifyOperation += 1;
      if (options.verifyOperation)
        return options.verifyOperation(receipt, definition, snapshot, workspaceRoot);
      return { verified: true, manifest: receipt.manifest ?? [] };
    },
    workspaceIdentity: () => options.workspaceRoot ?? 'E:\\test-only-workspace',
    missionIdForStep(workflowRunId, stepId) {
      const stepRun = options.store
        .detail(workflowRunId)
        ?.steps.filter((item) => item.stepId === stepId)
        .sort((left, right) => right.attempt - left.attempt)[0];
      return stepRun?.missionId ?? null;
    },
    completeMission,
  };
}
