import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
} from '@cultivation/persistence';
import { R32AvailabilityRepository } from '@cultivation/persistence';
import { GenerationSqliteRepository } from '@cultivation/persistence/g1-generation';
import { GenerationService, GenerationCrash } from '@cultivation/application/g1-generation';
import type { GenerationArtifactPort } from '@cultivation/application/g1-generation';
import {
  createGenerationAvailabilityService,
  GenerationAvailabilityGateway,
} from '@cultivation/application/g2-availability';
import type { SecretStore } from '@cultivation/application';
import type { PermissionEngine } from '@cultivation/application/permission-engine';
import { DomainError } from '@cultivation/shared';
import { H3GenerationGateway } from '@cultivation/agent-runtime/h3-generation-gateway';
import { GenerationArtifactStore } from './g1-artifact-store.js';
import { GenerationMediaStore } from './g2-media-store.js';
import { GenerationAdapterStateStore } from './g2-adapter-state.js';
import { GenerationChatService } from './g2-chat.js';
import type { GenerationChatServiceOptions } from './g2-chat.js';

/** Trusted Main dispatch; production never supplies a fake generation provider. */
export function h3GenerationFoundation(options: {
  db: Database.Database;
  userData: string;
  store: Gate1SqliteRepository;
  missions: Gate3SqliteRepository;
  tools: Gate4SqliteRepository;
  permission: PermissionEngine;
  secrets: SecretStore;
  onAvailabilityChanged?: Parameters<typeof createGenerationAvailabilityService>[4];
  chatCrash?: GenerationChatServiceOptions['crash'];
  approveMediaAccess?: (
    task: import('@cultivation/domain/g1-generation').GenerationTask,
    capability: 'FILE_READ' | 'FILE_WRITE',
    resource: string,
  ) => boolean;
  /** Trusted Main test composition only; never supplied by Renderer/IPC. */
  gatewayDecorator?: (
    gateway: import('@cultivation/application/g1-generation').GenerationGateway,
  ) => import('@cultivation/application/g1-generation').GenerationGateway;
}) {
  const { db, store } = options;
  const repository = new GenerationSqliteRepository(db);
  const media = new GenerationMediaStore(options.userData, db);
  const h3 = new H3GenerationGateway(
    async (id: string) => {
      const runtime = store.getRuntimeProfile(id);
      const provider = runtime ? store.getProvider(runtime.providerId) : null;
      if (
        !runtime ||
        runtime.executionProtocol !== 'GENERATION' ||
        provider?.kind !== 'GENERATION_HTTP' ||
        provider.adapterId !== 'H3' ||
        !provider.baseUrl
      )
        throw new DomainError('MODEL_NOT_FOUND', '生成服务执行身份无效');
      if (!provider.enabled) throw new DomainError('MODEL_UNAVAILABLE', '生成服务已停用');
      const credential = runtime.credentialId ? store.getCredential(runtime.credentialId) : null;
      if (runtime.credentialId && (!credential || credential.providerId !== provider.id))
        throw new DomainError('AUTH_FAILED', '生成服务凭证无效');
      return {
        baseUrl: provider.baseUrl,
        modelId: runtime.modelId,
        apiKey: credential ? await options.secrets.decrypt(credential.ciphertext) : '',
      };
    },
    new GenerationAdapterStateStore(db),
    media,
  );
  const raw = options.gatewayDecorator?.(h3) ?? h3;
  const resolver = {
    resolveRuntime: (id: string) => {
      const teammate = store
        .listTeammates()
        .find((t) => t.executorKind === 'MODEL_RUNTIME' && t.currentRuntimeProfileId === id);
      const binding = teammate ? store.getModelBinding(teammate.id) : null;
      return teammate && binding && binding.executionProtocol === 'GENERATION'
        ? { teammateId: teammate.id, modelId: binding.modelId }
        : null;
    },
  };
  const availability = createGenerationAvailabilityService(
    new R32AvailabilityRepository(db),
    store,
    raw,
    resolver,
    options.onAvailabilityChanged,
  );
  const gateway = new GenerationAvailabilityGateway(raw, availability, resolver);
  const outputStore = new GenerationArtifactStore({
    userData: options.userData,
    repository,
    workspaceRoot: () => options.tools.getWorkspaceRoot(),
    authorize: async (task, capability, resource) => {
      const result = options.permission.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: task.targetTeammateId,
        teammateId: task.targetTeammateId,
        missionId: task.missionId,
        capability,
        resource,
      });
      if (
        result.decision !== 'ALLOW' &&
        !(result.decision === 'ASK' && options.approveMediaAccess?.(task, capability, resource))
      )
        throw new DomainError(
          result.decision === 'DENY' ? 'PERMISSION_DENIED' : 'APPROVAL_REQUIRED',
          '生成文件操作需要明确授权',
        );
    },
  });
  const artifacts: GenerationArtifactPort = {
    fingerprint: (value) => outputStore.fingerprint(value),
    resolveInput: async (binding, task, opts) =>
      media.get(binding.artifactId)
        ? media.resolveInput(binding.artifactId, binding.role)
        : outputStore.resolveInput(binding, task, opts),
    commit: (...args) => outputStore.commit(...args),
    verify: (...args) => outputStore.verify(...args),
  };
  const service = new GenerationService(
    repository,
    gateway,
    {
      requireGenerationIdentity: (id) => {
        const teammate = store.getTeammate(id);
        const binding = store.getModelBinding(id);
        const identity = binding ? resolver.resolveRuntime(binding.runtimeProfileId) : null;
        const runtime = binding ? store.getRuntimeProfile(binding.runtimeProfileId) : null;
        const provider = runtime ? store.getProvider(runtime.providerId) : null;
        if (teammate?.status === 'ARCHIVED' || provider?.enabled === false)
          throw new GenerationCrash('执行暂不可用；保留原生成任务，禁止重提或改派');
        if (
          !teammate ||
          teammate.status !== 'ACTIVE' ||
          !identity ||
          !binding ||
          !store.hasValidModelBinding(id)
        )
          throw new DomainError('INVALID_INPUT', '请选择有效的固定生成模型道友');
        return { runtimeProfileId: binding.runtimeProfileId, modelId: identity.modelId };
      },
      validateDestination: async (task) => {
        if (task.outputDestination.scope === 'MISSION_WORKSPACE') {
          const mission = task.missionId ? options.missions.getMission(task.missionId) : null;
          const run = task.runId ? options.missions.getRun(task.runId) : null;
          const fact = mission
            ? options.missions
                .listMissionEvents(mission.id)
                .find(
                  (e) =>
                    e.runId === task.runId &&
                    e.eventType === 'generation.output_destination_bound' &&
                    e.payloadJson.teammateId === task.targetTeammateId &&
                    e.payloadJson.logicalPathHint === task.outputDestination.logicalPathHint,
                )
            : null;
          if (!mission || !run || run.missionId !== mission.id || !fact)
            throw new DomainError('WORKSPACE_REQUIRED', '输出必须绑定可信历练交付约束');
        }
        await outputStore.validateDestination(task);
      },
    },
    artifacts,
    { id: randomUUID },
  );
  const chat = new GenerationChatService(db, store, service, gateway, availability, {
    crash: options.chatCrash,
  });
  const listAttachments = () => [
    ...media.list(),
    ...repository
      .listJobs()
      .filter((j) => j.state === 'COMPLETED')
      .flatMap((j) => repository.listArtifacts(j.id))
      .filter((a) => a.storageScope === 'APP_ARTIFACT_STORE')
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        mimeType: a.mimeType,
        contentHash: a.contentHash,
        sizeBytes: a.sizeBytes,
        name: a.kind === 'VIDEO' ? '视频结果' : a.kind === 'AUDIO' ? '音频结果' : '图片结果',
      })),
  ];
  return { service, gateway, repository, artifacts, media, availability, chat, listAttachments };
}
