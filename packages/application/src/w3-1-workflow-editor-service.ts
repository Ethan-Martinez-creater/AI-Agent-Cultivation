import { randomUUID } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  compileUserWorkflowVersion,
  copyWorkflowVersionToDraftContent,
  parseWorkflowDraftContent,
  reorderWorkflowDraft,
  validateUserWorkflowDraft,
  type WorkflowDraft,
  type WorkflowDraftContent,
  type WorkflowVersion,
} from '@cultivation/domain';
import type { WorkflowRepository } from './w1-workflow-ports.js';
import type { WorkflowService } from './w1-workflow-service.js';

export interface WorkflowDraftRepositoryPort {
  transaction<T>(fn: () => T): T;
  insertDraft(value: WorkflowDraft): void;
  saveDraft(value: WorkflowDraft, expectedRevision: number): boolean;
  deleteDraft(id: string, expectedRevision: number): boolean;
  getDraft(id: string): WorkflowDraft | null;
  listDrafts(): WorkflowDraft[];
}

export interface WorkflowEditorClock {
  now(): string;
  id(): string;
}

const DEFAULT_WORKFLOW_NAME = '未命名工作流';
const DEFAULT_STEP_ID = 'task-1';

/** Main-owned authoring commands for USER Workflow drafts and immutable releases. */
export class WorkflowEditorService {
  constructor(
    private readonly drafts: WorkflowDraftRepositoryPort,
    private readonly workflows: WorkflowRepository,
    private readonly publisher: Pick<WorkflowService, 'publish'>,
    private readonly clock: WorkflowEditorClock = {
      now: () => new Date().toISOString(),
      id: () => randomUUID(),
    },
  ) {}

  listDrafts(): WorkflowDraft[] {
    return this.drafts.listDrafts();
  }

  getDraft(id: string): WorkflowDraft {
    const draft = this.drafts.getDraft(id);
    if (!draft) throw new DomainError('NOT_FOUND', 'Workflow Draft 不存在');
    this.assertUserDefinition(draft.definitionId);
    return draft;
  }

  createDraft(input: { name?: string } = {}): WorkflowDraft {
    const content = parseWorkflowDraftContent({
      ...defaultContent(),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    const at = this.clock.now();
    const draft: WorkflowDraft = {
      id: this.clock.id(),
      definitionId: `user.${this.clock.id()}`,
      baseVersion: null,
      revision: 1,
      content,
      createdAt: at,
      updatedAt: at,
    };
    this.drafts.insertDraft(draft);
    return draft;
  }

  saveDraft(input: {
    id: string;
    expectedRevision: number;
    content: WorkflowDraftContent;
  }): WorkflowDraft {
    const current = this.getDraft(input.id);
    this.assertRevision(current, input.expectedRevision);
    const content = parseWorkflowDraftContent(input.content);
    const next: WorkflowDraft = {
      ...current,
      revision: current.revision + 1,
      content,
      updatedAt: this.clock.now(),
    };
    if (!this.drafts.saveDraft(next, input.expectedRevision)) this.conflict();
    return this.getDraft(current.id);
  }

  reorderDraft(input: {
    id: string;
    expectedRevision: number;
    stepIds: readonly string[];
  }): WorkflowDraft {
    const current = this.getDraft(input.id);
    this.assertRevision(current, input.expectedRevision);
    return this.saveDraft({
      id: current.id,
      expectedRevision: current.revision,
      content: reorderWorkflowDraft(current.content, input.stepIds),
    });
  }

  editVersion(input: { definitionId: string; version: number }): WorkflowDraft {
    const version = this.requireVersion(input.definitionId, input.version);
    if (version.definition.source !== 'USER') {
      throw new DomainError('INVALID_INPUT', '只有我的 Workflow 可以直接编辑');
    }
    const head = this.latestVersion(input.definitionId);
    if (head?.version !== version.version) this.conflict();
    const existing = this.drafts
      .listDrafts()
      .find((draft) => draft.definitionId === input.definitionId);
    if (existing) {
      if (existing.baseVersion === version.version) return existing;
      this.conflict();
    }
    return this.insertFromVersion(version, input.definitionId, version.version);
  }

  copyVersion(input: { definitionId: string; version: number; name?: string }): WorkflowDraft {
    const version = this.requireVersion(input.definitionId, input.version);
    if (version.definition.source === 'IMPORTED') {
      throw new DomainError('INVALID_INPUT', 'IMPORTED Workflow 本轮不能复制');
    }
    const copiedContent = copyWorkflowVersionToDraftContent(version);
    const content = parseWorkflowDraftContent({
      ...copiedContent,
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    return this.insertNewDraft(content);
  }

  publishDraft(input: { id: string; expectedRevision: number }): WorkflowVersion {
    return this.workflows.transaction(() =>
      this.drafts.transaction(() => {
        const draft = this.getDraft(input.id);
        this.assertRevision(draft, input.expectedRevision);
        const head = this.latestVersion(draft.definitionId);
        if (
          (draft.baseVersion === null && head !== null) ||
          (draft.baseVersion !== null && head?.version !== draft.baseVersion)
        )
          this.conflict();
        validateUserWorkflowDraft(draft.content);
        const nextVersion = (head?.version ?? 0) + 1;
        const version = compileUserWorkflowVersion(draft, nextVersion, this.clock.now());
        this.publisher.publish(version);
        if (!this.drafts.deleteDraft(draft.id, input.expectedRevision)) this.conflict();
        return version;
      }),
    );
  }

  private insertFromVersion(
    version: WorkflowVersion,
    definitionId: string,
    baseVersion: number,
  ): WorkflowDraft {
    const at = this.clock.now();
    const draft: WorkflowDraft = {
      id: this.clock.id(),
      definitionId,
      baseVersion,
      revision: 1,
      content: parseWorkflowDraftContent(copyWorkflowVersionToDraftContent(version)),
      createdAt: at,
      updatedAt: at,
    };
    this.drafts.insertDraft(draft);
    return draft;
  }

  private insertNewDraft(content: WorkflowDraftContent): WorkflowDraft {
    const at = this.clock.now();
    const draft: WorkflowDraft = {
      id: this.clock.id(),
      definitionId: `user.${this.clock.id()}`,
      baseVersion: null,
      revision: 1,
      content,
      createdAt: at,
      updatedAt: at,
    };
    this.drafts.insertDraft(draft);
    return draft;
  }

  private requireVersion(definitionId: string, version: number): WorkflowVersion {
    const value = this.workflows.getVersion(definitionId, version);
    if (!value) throw new DomainError('NOT_FOUND', 'Workflow 版本不存在');
    return value;
  }

  private latestVersion(definitionId: string): WorkflowVersion | null {
    return (
      this.workflows
        .listVersions()
        .filter((version) => version.definition.id === definitionId)
        .sort((left, right) => right.version - left.version)[0] ?? null
    );
  }

  private assertUserDefinition(definitionId: string): void {
    const versions = this.workflows
      .listVersions()
      .filter((version) => version.definition.id === definitionId);
    if (versions.some((version) => version.definition.source !== 'USER')) {
      throw new DomainError('INVALID_INPUT', '只有 USER Workflow Draft 可以编辑');
    }
  }

  private assertRevision(draft: WorkflowDraft, expectedRevision: number): void {
    if (draft.revision !== expectedRevision) this.conflict();
  }

  private conflict(): never {
    throw new DomainError('CONFLICT', 'Workflow Draft 已发生变化，请重新载入后再试');
  }
}

function defaultContent(): WorkflowDraftContent {
  return {
    name: DEFAULT_WORKFLOW_NAME,
    description: '',
    category: '通用',
    inputSchema: EMPTY_WORKFLOW_INPUT_SCHEMA,
    finalOutputs: [
      {
        key: 'result',
        fromStepId: DEFAULT_STEP_ID,
        outputKey: 'result',
        required: true,
        description: '工作流最终结果',
      },
    ],
    entryStepId: DEFAULT_STEP_ID,
    steps: [
      {
        id: DEFAULT_STEP_ID,
        type: 'TASK',
        title: '处理任务',
        objective: '',
        routing: { requiredCapabilities: ['GENERAL_REASONING'], executionConstraint: 'SOLO' },
        inputs: [],
        outputs: [
          {
            key: 'result',
            kind: 'TEXT',
            required: true,
            contractId: 'user.text',
            contractVersion: '1',
            maxSizeBytes: 100_000,
            description: '工作流最终结果',
            validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
          },
        ],
        maxAttempts: 1,
        exitCondition: 'VALID_OUTPUTS',
      },
    ],
    edges: [
      {
        id: 'task-finish',
        fromStepId: DEFAULT_STEP_ID,
        toStepId: null,
        branch: 'COMPLETE',
        condition: { type: 'ALWAYS' },
      },
    ],
  };
}
