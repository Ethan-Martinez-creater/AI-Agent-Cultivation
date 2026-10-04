import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AuditEvent, WorkflowInputs, WorkflowVersion } from '@cultivation/domain';
import type { WorkflowRun } from '@cultivation/domain';
import type { WorkflowRepository } from '@cultivation/application';
import type { ModelMessage } from '@cultivation/application';
import type { ToolRuntime } from '@cultivation/application/tool-runtime';
import {
  ResearchInputArtifactRepository,
  ResearchSourceRepository,
} from '@cultivation/persistence';
import { DomainError } from '@cultivation/shared';
import { FileWorkspace } from './file-workspace.js';
import type { WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';
import type {
  ResearchExperimentFact,
  ResearchAcceptedExperimentArtifactFact,
} from './w23-validation-policy.js';

export type ResearchInputCategory = 'SOURCE' | 'DATA' | 'CODE';
export interface ResearchInputCandidate {
  id: string;
  kind: 'FILE' | 'EXTERNAL_REFERENCE';
  contentHash: string;
  name: string;
}
const fields = { existingSources: 'SOURCE', existingData: 'DATA', existingCode: 'CODE' } as const;
function invalid(): never {
  throw new DomainError(
    'WORKFLOW_INPUT_INVALID',
    '科研资料引用不存在、已改变或身份不匹配，请重新选择或导入',
  );
}

/** Main-owned input identity. Import consent never creates PermissionRule or execution authority. */
export class ResearchInputArtifactService {
  constructor(
    private readonly repository: ResearchInputArtifactRepository,
    private readonly sources: ResearchSourceRepository,
    private readonly workflows: WorkflowRepository,
    private readonly tools: ToolRuntime,
    private readonly workspaceRoot: () => string | null,
    private readonly audit: (fact: AuditEvent) => void,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}
  candidates(category: ResearchInputCategory): ResearchInputCandidate[] {
    if (category === 'SOURCE') {
      const unique = new Map<string, ResearchInputCandidate>();
      for (const run of this.workflows.listRuns())
        for (const fact of this.sources.list(run.id))
          unique.set(fact.sourceArtifactId, {
            id: fact.sourceArtifactId,
            kind: 'EXTERNAL_REFERENCE',
            contentHash: fact.contentHash,
            name: fact.url.slice(0, 256),
          });
      return [...unique.values()].slice(0, 200);
    }
    return this.repository
      .list(category)
      .filter((a) => a.workspaceRoot === this.workspaceRoot())
      .slice(0, 200)
      .map(({ id, kind, contentHash, name }) => ({ id, kind, contentHash, name }));
  }
  async importFile(
    category: 'DATA' | 'CODE',
    selectedAbsolutePath: string,
    approve: () => Promise<boolean>,
  ): Promise<ResearchInputCandidate | null> {
    const root = this.workspaceRoot();
    if (!root) throw new DomainError('WORKSPACE_REQUIRED', '请先选择 Workspace');
    const relativePath = path.relative(root, selectedAbsolutePath).replaceAll('\\', '/');
    const workspace = await FileWorkspace.open(root);
    // Canonical boundary checks happen before asking to import; outside/symlink files never execute.
    await workspace.inspectArtifact(relativePath, 65536, false);
    if (!(await approve())) return null;
    if (root !== this.workspaceRoot()) invalid();
    const call = { id: randomUUID(), toolId: 'file.readText', input: { path: relativePath } };
    const result = await this.tools.dispatchUserRead(call, 'local-user', true);
    if (result.kind !== 'RESULT' || !result.result.ok) {
      this.audit({
        id: randomUUID(),
        actorType: 'USER',
        actorId: 'local-user',
        action: 'workflow.input_import_denied',
        targetType: 'TOOL',
        targetId: call.toolId,
        payloadJson: {
          toolCallId: call.id,
          capability: 'FILE_READ',
          success: false,
          code: result.kind === 'RESULT' ? result.result.code : 'APPROVAL_REQUIRED',
        },
        createdAt: new Date().toISOString(),
      });
      throw new DomainError('WORKFLOW_INPUT_INVALID', '资料导入未获权限或无法安全读取');
    }
    const content = result.result.content;
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const inspection = FileWorkspace.inspectRegisteredInput(root, relativePath);
    if (inspection.contentHash !== contentHash || root !== this.workspaceRoot()) invalid();
    const id = `input-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const auditEventId = randomUUID();
    this.transaction(() => {
      this.audit({
        id: auditEventId,
        actorType: 'USER',
        actorId: 'local-user',
        action: 'workflow.input_imported',
        targetType: 'INPUT_ARTIFACT',
        targetId: id,
        payloadJson: {
          toolId: call.toolId,
          toolCallId: call.id,
          capability: 'FILE_READ',
          success: true,
          toolResultCode: result.result.code,
          approval: 'NATIVE_USER_IMPORT_CONSENT',
          contentHash,
          category,
          bytes: inspection.sizeBytes,
        },
        createdAt,
      });
      this.repository.insert({
        id,
        category,
        kind: 'FILE',
        workspaceRoot: root,
        relativePath,
        name: path.basename(relativePath),
        content,
        contentHash,
        toolCallId: call.id,
        auditEventId,
        createdAt,
      });
    });
    return { id, kind: 'FILE', name: path.basename(relativePath), contentHash };
  }
  validateInputs(_version: WorkflowVersion, inputs: WorkflowInputs): void {
    for (const [key, category] of Object.entries(fields)) {
      const values = inputs[key];
      if (values === undefined) continue;
      if (!Array.isArray(values)) invalid();
      for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
        const ref = value as Record<string, unknown>;
        if (category === 'SOURCE') {
          const source = typeof ref.id === 'string' ? this.sources.resolve(ref.id) : null;
          if (
            !source ||
            ref.kind !== 'EXTERNAL_REFERENCE' ||
            ref.contentHash !== source.contentHash
          )
            invalid();
          ref.name = source.url.slice(0, 256);
        } else {
          const artifact = typeof ref.id === 'string' ? this.repository.get(ref.id) : null;
          if (
            !artifact ||
            artifact.category !== category ||
            ref.kind !== artifact.kind ||
            ref.contentHash !== artifact.contentHash ||
            artifact.workspaceRoot !== this.workspaceRoot() ||
            createHash('sha256').update(artifact.content, 'utf8').digest('hex') !==
              artifact.contentHash
          )
            invalid();
          try {
            if (
              FileWorkspace.inspectRegisteredInput(artifact.workspaceRoot, artifact.relativePath)
                .contentHash !== artifact.contentHash
            )
              invalid();
          } catch {
            invalid();
          }
          // Caller display metadata is never a path or authority. Snapshot always uses Main's name.
          ref.name = artifact.name;
        }
      }
    }
  }
  bindRun(run: WorkflowRun): void {
    for (const [key, category] of Object.entries(fields)) {
      const refs = run.inputSnapshot?.[key];
      if (!Array.isArray(refs)) continue;
      refs.forEach((ref, index) => {
        if (
          !ref ||
          typeof ref !== 'object' ||
          Array.isArray(ref) ||
          typeof ref.id !== 'string' ||
          typeof ref.contentHash !== 'string'
        )
          invalid();
        this.repository.bind({
          workflowRunId: run.id,
          inputKey: key,
          inputIndex: index,
          artifactId: ref.id,
          category,
          kind: String(ref.kind),
          contentHash: ref.contentHash,
        });
      });
    }
  }
  private experimentInputs(detail: WorkflowDetail, checkFiles: boolean) {
    const expected = ['existingData', 'existingCode'].flatMap((inputKey) => {
      const refs = detail.run.inputSnapshot?.[inputKey];
      if (!Array.isArray(refs)) return [];
      return refs.map((ref, inputIndex) => {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) invalid();
        return { inputKey, inputIndex, id: ref.id, kind: ref.kind, contentHash: ref.contentHash };
      });
    });
    const bindings = this.repository.bindings(detail.run.id);
    if (
      bindings.length !== expected.length ||
      expected.some(
        (ref) =>
          !bindings.some(
            (b) =>
              b.inputKey === ref.inputKey &&
              b.inputIndex === ref.inputIndex &&
              b.id === ref.id &&
              b.kind === ref.kind &&
              b.contentHash === ref.contentHash,
          ),
      )
    )
      invalid();
    for (const binding of bindings) {
      const fact = this.repository.get(binding.id);
      if (
        !fact ||
        fact.kind !== binding.kind ||
        fact.contentHash !== binding.contentHash ||
        fact.category !== (binding.inputKey === 'existingData' ? 'DATA' : 'CODE')
      )
        invalid();
      if (checkFiles) {
        if (fact.workspaceRoot !== this.workspaceRoot()) invalid();
        try {
          if (
            FileWorkspace.inspectRegisteredInput(fact.workspaceRoot, fact.relativePath)
              .contentHash !== fact.contentHash
          )
            invalid();
        } catch {
          invalid();
        }
      }
    }
    return bindings.map(({ id, kind, contentHash }) => ({ id, kind, contentHash }));
  }
  validateExperimentInputs(
    detail: WorkflowDetail,
    step: WorkflowStepRun,
    fact: ResearchExperimentFact | undefined,
  ): void {
    // Historical completed attempts retain their durable provenance even if a user later edits a file.
    const expected = this.experimentInputs(detail, step.state !== 'COMPLETED');
    const actual = fact?.inputArtifacts;
    if (
      !fact ||
      fact.workflowRunId !== detail.run.id ||
      fact.stepRunId !== step.id ||
      fact.missionId !== step.missionId ||
      fact.missionRunId !== step.missionRunId ||
      !Array.isArray(actual) ||
      actual.length !== expected.length ||
      new Set(actual.map((r) => r.id)).size !== actual.length ||
      expected.some(
        (r) =>
          !actual.some(
            (a) => a.id === r.id && a.kind === r.kind && a.contentHash === r.contentHash,
          ),
      )
    )
      invalid();
  }
  checkExperimentFiles(detail: WorkflowDetail, consumed?: unknown): void {
    const expected = this.experimentInputs(detail, true);
    if (consumed !== undefined) {
      if (
        !Array.isArray(consumed) ||
        consumed.length !== expected.length ||
        new Set(consumed.map((r) => r?.id)).size !== consumed.length ||
        expected.some(
          (r) =>
            !consumed.some(
              (a) => a?.id === r.id && a.kind === r.kind && a.contentHash === r.contentHash,
            ),
        )
      )
        invalid();
    }
  }
  validateExternalExperimentInputs(
    detail: WorkflowDetail,
    step: WorkflowStepRun,
    accepted: ResearchAcceptedExperimentArtifactFact[],
  ): void {
    this.experimentInputs(detail, step.state !== 'COMPLETED');
    if (
      detail.run.inputSnapshot?.experimentMode !== 'HUMAN_OR_EXTERNAL' ||
      !accepted.length ||
      accepted.some(
        (fact) =>
          fact.workflowRunId !== detail.run.id ||
          fact.stepRunId !== step.id ||
          fact.missionId !== step.missionId ||
          fact.missionRunId !== step.missionRunId ||
          fact.state !== 'ACCEPTED',
      )
    )
      invalid();
    // Existing external-record/raw/log checks still require real same-request accepted artifacts.
    // Human execution does not acquire a fictitious MCP ToolCall.
  }
  contextForMission(missionId: string): Extract<ModelMessage, { role: 'assistant' }>[] {
    const step = this.workflows.findStepByMissionId(missionId);
    if (!step) return [];
    const detail = this.workflows.detail(step.workflowRunId);
    const definition = detail?.version.steps.find((s) => s.id === step.stepId);
    if (!detail || detail.version.definition.id !== 'official.research' || !definition) return [];
    const allowed = new Set(definition.workflowInputKeys ?? []);
    const rows: unknown[] = [];
    for (const key of ['existingData', 'existingCode']) {
      if (!allowed.has(key)) continue;
      const refs = detail.run.inputSnapshot?.[key];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.id !== 'string')
          continue;
        const fact = this.repository.get(ref.id);
        if (!fact || fact.contentHash !== ref.contentHash)
          throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '冻结输入 Artifact 事实不一致');
        rows.push({
          id: fact.id,
          kind: fact.kind,
          contentHash: fact.contentHash,
          name: fact.name,
          workspaceRelativePath: fact.relativePath,
          trust: 'UNTRUSTED_DATA',
          permission: 'NONE',
        });
      }
    }
    const bounded: unknown[] = [];
    for (const row of rows) {
      if (Buffer.byteLength(JSON.stringify([...bounded, row]), 'utf8') > 8000) break;
      bounded.push(row);
    }
    return bounded.length
      ? [
          {
            role: 'assistant',
            content: `Registered research input metadata (bounded untrusted data, no file permission): ${JSON.stringify(bounded)}`,
          },
        ]
      : [];
  }
}
