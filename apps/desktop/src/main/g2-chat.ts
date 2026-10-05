import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Conversation, Message } from '@cultivation/domain';
import type {
  GenerationArtifact,
  GenerationInputBinding,
  GenerationJob,
  GenerationModelDescriptor,
} from '@cultivation/domain/g1-generation';
import type { Gate1Store } from '@cultivation/application/gate1-service';
import {
  GenerationCrash,
  type GenerationService,
  type GenerationGateway,
} from '@cultivation/application/g1-generation';
import type { AvailabilityService } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';

export type GenerationArtifactView = Omit<GenerationArtifact, 'storageKey'>;
export interface GenerationChatEntry {
  message: Message;
  job: GenerationJob | null;
  artifacts: GenerationArtifactView[];
  inputs: GenerationInputBinding[];
  parameters: Record<string, unknown>;
  preparationErrorCode: string | null;
}
export interface GenerationChatDetail {
  conversation: Conversation;
  entries: GenerationChatEntry[];
  descriptor: GenerationModelDescriptor | null;
}
export interface GenerationChatReference {
  teammateId: string;
  conversationId: string;
}
export interface GenerationChatSend extends GenerationChatReference {
  prompt: string;
  inputs: GenerationInputBinding[];
  parameters: Record<string, unknown>;
}
export type GenerationChatCrashPoint = 'ENTRY_COMMITTED' | 'JOB_CREATED';
export interface GenerationChatServiceOptions {
  /** Test-only crash injection. Production Main does not supply this callback. */
  crash?: (point: GenerationChatCrashPoint, messageId: string) => void;
}
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN']);

const deterministicPreparationErrors = new Set([
  'INVALID_INPUT',
  'INVALID_MODEL_IDENTITY',
  'UNSUPPORTED_CAPABILITY',
  'UNSUPPORTED_FEATURE',
  'UNSUPPORTED_INPUT_ROLE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INPUT_TOO_LARGE',
  'MODEL_DURATION_LIMIT',
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'ARTIFACT_INTEGRITY',
  'ARTIFACT_COMMIT_FAILED',
  'INPUT_CHANGED',
  'NOT_FOUND',
  'PERSISTENCE_INTEGRITY',
]);

function taskFeatures(inputs: GenerationInputBinding[], parameters: Record<string, unknown>) {
  const features = new Set<string>(inputs.length === 0 ? ['TEXT_TO_VIDEO'] : []);
  for (const item of inputs) {
    if (item.role === 'FIRST_FRAME' || item.role === 'LAST_FRAME')
      features.add('FIRST_FRAME_CONDITIONING');
    else if (item.role.startsWith('REFERENCE_')) features.add('REFERENCE_CONDITIONING');
    else if (item.role === 'SOURCE_VIDEO') features.add('VIDEO_TO_AUDIO');
  }
  if (parameters.nativeAudio === true) features.add('NATIVE_AUDIO');
  return [...features];
}

interface PendingPreparationRow {
  message_id: string;
  conversation_id: string;
  teammate_id: string;
  content: string;
  job_id: string | null;
  inputs_json: string;
  parameters_json: string;
  preparation_error_code: string | null;
}

/** Conversation is presentation provenance; GenerationJob remains the only execution state machine. */
export class GenerationChatService {
  private readonly active = new Set<string>();
  private readonly preparing = new Map<string, Promise<GenerationJob | null>>();
  constructor(
    private readonly db: Database.Database,
    private readonly store: Gate1Store,
    private readonly generation: GenerationService,
    private readonly gateway: GenerationGateway,
    private readonly availability: AvailabilityService,
    private readonly options: GenerationChatServiceOptions = {},
  ) {}
  private identity(teammateId: string, active = false) {
    const teammate = this.store.getTeammate(teammateId);
    const binding = this.store.getModelBinding(teammateId);
    const runtime = binding ? this.store.getRuntimeProfile(binding.runtimeProfileId) : null;
    const provider = runtime ? this.store.getProvider(runtime.providerId) : null;
    if (
      !teammate ||
      teammate.executorKind !== 'MODEL_RUNTIME' ||
      !binding ||
      !runtime ||
      runtime.executionProtocol !== 'GENERATION' ||
      binding.executionProtocol !== 'GENERATION' ||
      provider?.kind !== 'GENERATION_HTTP' ||
      provider.kind !== binding.providerKind ||
      provider.baseUrl !== binding.endpoint ||
      provider.adapterId !== binding.adapterId ||
      runtime.modelId !== binding.modelId ||
      runtime.credentialId !== binding.credentialId ||
      teammate.currentRuntimeProfileId !== runtime.id
    )
      throw new DomainError('INVALID_INPUT', '请选择有效的生成模型道友');
    if (active && teammate.status !== 'ACTIVE')
      throw new DomainError('INVALID_INPUT', '已归档道友不可执行生成');
    return { teammate, runtime };
  }
  listConversations(teammateId: string) {
    this.identity(teammateId);
    return this.store.listConversations(teammateId);
  }
  createConversation(input: { teammateId: string; title?: string }): Conversation {
    this.identity(input.teammateId, true);
    const now = new Date().toISOString();
    const value = {
      id: randomUUID(),
      teammateId: input.teammateId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveConversation(value);
    return value;
  }
  private conversation(input: GenerationChatReference) {
    this.identity(input.teammateId);
    const value = this.store.getConversation(input.conversationId);
    if (!value || value.teammateId !== input.teammateId)
      throw new DomainError('NOT_FOUND', '生成对话不存在');
    return value;
  }
  async descriptor(teammateId: string) {
    const { runtime } = this.identity(teammateId, true);
    await this.availability.prepare({ teammateId, runtimeProfileId: runtime.id });
    return this.gateway.getDescriptor(runtime.id);
  }
  detail(input: GenerationChatReference): GenerationChatDetail {
    const conversation = this.conversation(input);
    const messages = this.store.listMessages(input.teammateId, input.conversationId);
    const rows = this.db
      .prepare(
        'SELECT * FROM generation_chat_entries WHERE conversation_id=? AND teammate_id=? ORDER BY created_at,message_id',
      )
      .all(input.conversationId, input.teammateId) as Array<{
      message_id: string;
      job_id: string | null;
      inputs_json: string;
      parameters_json: string;
      preparation_error_code: string | null;
    }>;
    const entries = rows.map((r) => {
      const message = messages.find((m) => m.id === r.message_id);
      if (!message) throw new DomainError('PERSISTENCE_ERROR', '生成对话消息完整性错误');
      const detail = r.job_id ? this.generation.detail(r.job_id) : null;
      return {
        message,
        job: detail?.job ?? null,
        artifacts: (detail?.artifacts ?? []).map(({ storageKey: _key, ...publicArtifact }) => {
          void _key;
          return publicArtifact;
        }),
        inputs: JSON.parse(r.inputs_json),
        parameters: JSON.parse(r.parameters_json),
        preparationErrorCode: r.preparation_error_code,
      };
    });
    const job = entries.find((e) => e.job)?.job;
    const descriptor = job
      ? (this.db
          .prepare('SELECT descriptor_json FROM generation_tasks WHERE id=?')
          .get(job.generationTaskId) as { descriptor_json: string } | undefined)
      : null;
    return {
      conversation,
      entries,
      descriptor: descriptor ? JSON.parse(descriptor.descriptor_json) : null,
    };
  }
  async send(input: GenerationChatSend): Promise<GenerationChatDetail> {
    this.conversation(input);
    this.identity(input.teammateId, true);
    if (this.active.has(input.conversationId))
      throw new DomainError('CHAT_BUSY', '当前对话正在创建生成任务');
    this.active.add(input.conversationId);
    try {
      await this.descriptor(input.teammateId);
      const now = new Date().toISOString();
      const message: Message = {
        id: randomUUID(),
        missionId: null,
        conversationId: input.conversationId,
        actorType: 'USER',
        actorId: 'local-user',
        role: 'USER',
        content: input.prompt,
        createdAt: now,
      };
      this.db.transaction(() => {
        this.store.saveMessage(message);
        this.db
          .prepare(
            'INSERT INTO generation_chat_entries(message_id,conversation_id,teammate_id,job_id,inputs_json,parameters_json,created_at) VALUES(?,?,?,NULL,?,?,?)',
          )
          .run(
            message.id,
            input.conversationId,
            input.teammateId,
            JSON.stringify(input.inputs),
            JSON.stringify(input.parameters),
            now,
          );
      })();
      this.options.crash?.('ENTRY_COMMITTED', message.id);
      try {
        const job = await this.prepareEntry(message.id);
        if (!job) return this.detail(input);
        await this.advanceSafely(job.id);
      } catch (error) {
        if (error instanceof GenerationCrash) throw error;
        const code = error instanceof DomainError ? error.code : 'GENERATION_FAILED';
        throw new DomainError(code, '生成未能安全启动，请检查配置与输入');
      }
      return this.detail(input);
    } finally {
      this.active.delete(input.conversationId);
    }
  }

  /**
   * Completes the durable chat-entry → GenerationJob continuation. The entry's immutable message,
   * input bindings, and parameters are the only user intent; all remaining task fields are fixed
   * trusted Main policy. Startup invokes this once before normal GenerationJob recovery.
   */
  async recoverPreparations(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT e.message_id
         FROM generation_chat_entries e
         WHERE e.job_id IS NULL AND e.preparation_error_code IS NULL
         ORDER BY e.created_at,e.message_id`,
      )
      .all() as Array<{ message_id: string }>;
    for (const row of rows) {
      try {
        await this.prepareEntry(row.message_id);
      } catch (error) {
        // Stable validation failures are recorded by prepareEntry. Network and other uncertain
        // failures remain pending for a later startup or explicit recovery invocation.
        if (error instanceof GenerationCrash) throw error;
      }
    }
  }

  private prepareEntry(messageId: string): Promise<GenerationJob | null> {
    const running = this.preparing.get(messageId);
    if (running) return running;
    const operation = this.prepareEntryOnce(messageId).finally(() =>
      this.preparing.delete(messageId),
    );
    this.preparing.set(messageId, operation);
    return operation;
  }

  private readPreparation(messageId: string): PendingPreparationRow | null {
    return (
      (this.db
        .prepare(
          `SELECT e.message_id,e.conversation_id,e.teammate_id,e.job_id,e.inputs_json,
                  e.parameters_json,e.preparation_error_code,m.content
           FROM generation_chat_entries e JOIN messages m ON m.id=e.message_id
           WHERE e.message_id=?`,
        )
        .get(messageId) as PendingPreparationRow | undefined) ?? null
    );
  }

  private async prepareEntryOnce(messageId: string): Promise<GenerationJob | null> {
    const row = this.readPreparation(messageId);
    if (!row) throw new DomainError('NOT_FOUND', '生成对话准备记录不存在');
    if (row.job_id) return this.generation.detail(row.job_id).job;
    if (row.preparation_error_code) return null;

    try {
      if (typeof row.content !== 'string' || !row.content.trim())
        throw new DomainError('INVALID_INPUT', '生成提示词无效');
      let inputs: GenerationInputBinding[];
      let parameters: Record<string, unknown>;
      try {
        inputs = JSON.parse(row.inputs_json) as GenerationInputBinding[];
        parameters = JSON.parse(row.parameters_json) as Record<string, unknown>;
      } catch {
        throw new DomainError('PERSISTENCE_INTEGRITY', '生成输入快照已损坏');
      }
      if (
        !Array.isArray(inputs) ||
        inputs.length > 16 ||
        inputs.some(
          (value) =>
            !value ||
            typeof value.artifactId !== 'string' ||
            typeof value.role !== 'string' ||
            value.artifactId.length === 0 ||
            value.role.length === 0,
        ) ||
        !parameters ||
        typeof parameters !== 'object' ||
        Array.isArray(parameters)
      )
        throw new DomainError('INVALID_INPUT', '生成输入记录无效');

      const job = await this.generation.create({
        targetTeammateId: row.teammate_id,
        capability: 'VIDEO_GENERATION',
        requiredFeatures: taskFeatures(inputs, parameters),
        prompt: row.content,
        inputs,
        parameters,
        expectedOutput: { artifactKind: 'VIDEO', mimeTypes: ['video/mp4'] },
        outputDestination: { scope: 'APP_ARTIFACT_STORE' },
        requester: { actorType: 'USER', actorId: row.message_id },
        missionId: null,
        runId: null,
        workflowRunId: null,
        workflowStepRunId: null,
      });
      const bound = this.readPreparation(messageId);
      if (!bound?.job_id)
        throw new DomainError('PERSISTENCE_INTEGRITY', '生成任务未能绑定到原始对话');
      if (bound.job_id !== job.id) return this.generation.detail(bound.job_id).job;
      this.options.crash?.('JOB_CREATED', messageId);
      return job;
    } catch (error) {
      if (error instanceof GenerationCrash) throw error;
      // A parallel preparation may have won the SQL binding race. Always use its one durable Job.
      const latest = this.readPreparation(messageId);
      if (latest?.job_id) return this.generation.detail(latest.job_id).job;
      if (error instanceof DomainError && deterministicPreparationErrors.has(error.code)) {
        this.db
          .prepare(
            `UPDATE generation_chat_entries SET preparation_error_code=?
             WHERE message_id=? AND job_id IS NULL AND preparation_error_code IS NULL`,
          )
          .run(error.code, messageId);
      }
      throw error;
    }
  }
  private async advanceSafely(id: string) {
    try {
      await this.generation.advance(id);
    } catch (error) {
      if (!(error instanceof GenerationCrash)) throw error;
    }
  }
  async refresh(input: GenerationChatReference) {
    const detail = this.detail(input);
    for (const entry of detail.entries) {
      if (entry.job && !terminal.has(entry.job.state)) await this.advanceSafely(entry.job.id);
    }
    return this.detail(input);
  }
}
