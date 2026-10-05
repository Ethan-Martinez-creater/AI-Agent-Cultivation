import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { DomainError } from '@cultivation/shared';
import { GenerationService, GenerationCrash } from '@cultivation/application/g1-generation';
import type { GenerationTask } from '@cultivation/domain/g1-generation';
import type {
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
} from '@cultivation/persistence';
import { GenerationSqliteRepository } from '@cultivation/persistence/g1-generation';
import type { PermissionEngine } from '@cultivation/application/permission-engine';
import { GenerationArtifactStore } from './g1-artifact-store.js';
import { FakeGenerationGateway, UnconfiguredGenerationGateway } from './g1-fake-generation.js';

/** Main composition root. Fake provider and crash hooks require the explicit G1 test flag. */
export function generationFoundation(options: {
  db: Database.Database;
  userData: string;
  store: Gate1SqliteRepository;
  missions: Gate3SqliteRepository;
  tools: Gate4SqliteRepository;
  permission: PermissionEngine;
  testOnly: boolean;
  crash?: (point: string) => void;
}) {
  const { store, missions, tools, permission } = options;
  const repository = new GenerationSqliteRepository(options.db);
  const gateway = options.testOnly
    ? new FakeGenerationGateway(
        join(options.userData, 'g1-fake-provider.json'),
        (id) => store.getRuntimeProfile(id)?.modelId ?? '',
      )
    : new UnconfiguredGenerationGateway();
  const crash = (point: string) => {
    if (options.testOnly) options.crash?.(point);
    if (options.testOnly && process.argv.includes(`--g1-crash-${point.toLowerCase()}`))
      throw new GenerationCrash(point);
  };
  const artifacts = new GenerationArtifactStore({
    userData: options.userData,
    repository,
    workspaceRoot: () => tools.getWorkspaceRoot(),
    authorize: async (task, capability, resource) => {
      const decision = permission.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: task.targetTeammateId,
        teammateId: task.targetTeammateId,
        missionId: task.missionId,
        capability,
        resource,
      });
      if (decision.decision !== 'ALLOW')
        throw new DomainError(
          decision.decision === 'DENY' ? 'PERMISSION_DENIED' : 'APPROVAL_REQUIRED',
          '生成文件操作需要明确授权',
        );
    },
    crash: (point) => crash(point),
  });
  const validateDestination = async (task: GenerationTask) => {
    if (task.outputDestination.scope === 'MISSION_WORKSPACE') {
      if (!task.missionId || !task.runId)
        throw new DomainError('WORKSPACE_REQUIRED', '生成输出未绑定历练工作区');
      const mission = missions.getMission(task.missionId);
      const run = missions.getRun(task.runId);
      const binding = missions
        .listMissionEvents(task.missionId)
        .find(
          (e) =>
            e.runId === task.runId &&
            e.eventType === 'generation.output_destination_bound' &&
            e.payloadJson.teammateId === task.targetTeammateId &&
            e.payloadJson.logicalPathHint === task.outputDestination.logicalPathHint,
        );
      const participant = options.db
        .prepare('SELECT 1 FROM mission_participants WHERE mission_id=? AND teammate_id=?')
        .get(task.missionId, task.targetTeammateId);
      if (
        !mission ||
        !run ||
        run.missionId !== mission.id ||
        !binding ||
        (mission.coordinatorTeammateId !== task.targetTeammateId && !participant)
      )
        throw new DomainError('WORKSPACE_REQUIRED', '生成输出必须由可信历练交付约束绑定');
    }
    await artifacts.validateDestination(task);
  };
  const identities = {
    requireGenerationIdentity: (teammateId: string) => {
      const teammate = store.getTeammate(teammateId);
      const binding = store.getModelBinding(teammateId);
      const runtime = binding ? store.getRuntimeProfile(binding.runtimeProfileId) : null;
      if (
        !teammate ||
        teammate.status !== 'ACTIVE' ||
        teammate.executorKind !== 'MODEL_RUNTIME' ||
        !binding ||
        !runtime ||
        runtime.executionProtocol !== 'GENERATION' ||
        binding.executionProtocol !== 'GENERATION' ||
        !store.hasValidModelBinding(teammateId)
      )
        throw new DomainError('INVALID_INPUT', '请选择有效的固定生成模型道友');
      return { runtimeProfileId: runtime.id, modelId: runtime.modelId };
    },
    validateDestination,
  };
  const service = new GenerationService(repository, gateway, identities, artifacts, {
    id: randomUUID,
    crash: (point) => crash(point),
  });
  return { service, gateway, repository, artifacts };
}
