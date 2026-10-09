import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  WORKFLOW_IMPORT_POLICY_VERSION,
  transitionWorkflowRun,
  transitionWorkflowStep,
  validateArtifactContract,
  validateWorkflowInputs,
  validateWorkflowVersion,
  workflowImportSourceMetadataHash,
  workflowImportMappingHash,
  type WorkflowArtifact,
  type WorkflowArtifactSpec,
  type WorkflowDetail,
  type WorkflowInputs,
  type WorkflowVersion,
  type WorkflowImportProposal,
  type WorkflowImportSource,
  type WorkflowImportConfirmation,
  type WorkflowImportedArtifact,
} from '@cultivation/domain';
import type { WorkflowRepository } from './w1-workflow-ports.js';
import type { WorkflowImportRepositoryPort } from './w3-2-import-ports.js';
import {
  WorkflowService,
  validateWorkflowArtifact,
  workflowHash,
  W1_VALIDATOR_VERSION,
} from './w1-workflow-service.js';

export const WORKFLOW_IMPORT_POLICY = {
  version: WORKFLOW_IMPORT_POLICY_VERSION,
  maxSources: 16,
  maxSourceBytes: 65536,
  maxDescription: 2000,
} as const;

/** Main-owned canonical reinspection; never accepts a Renderer path or grants FILE_READ. */
export interface WorkflowImportSourcePort {
  recheck(source: WorkflowImportSource): void;
}
export interface WorkflowImportRevision {
  proposalId: string;
  revision: number;
  completedStepIds: string[];
  currentStepId: string;
  bindings: Array<{ stepId: string; outputKey: string; sourceId: string }>;
}

/** Offline suggestions have no state authority. Only confirm commits a new Run. */
export class WorkflowImportService {
  constructor(
    private readonly imports: WorkflowImportRepositoryPort,
    private readonly workflows: WorkflowRepository,
    private readonly engine: Pick<WorkflowService, 'createRun' | 'detail'>,
    private readonly sources: WorkflowImportSourcePort,
    private readonly clock = { now: () => new Date().toISOString(), id: () => randomUUID() },
  ) {}

  get(id: string): WorkflowImportProposal {
    const proposal = this.imports.getProposal(id);
    if (!proposal) throw new DomainError('NOT_FOUND', '导入建议不存在');
    return proposal;
  }
  list(): WorkflowImportProposal[] {
    return this.imports.listProposals().slice(0, 100);
  }

  prepare(input: {
    definitionId: string;
    version: number;
    inputs?: WorkflowInputs;
    description?: string;
  }): WorkflowImportProposal {
    const version = this.requireVersion(input.definitionId, input.version);
    const inputSnapshot = validateWorkflowInputs(
      version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA,
      input.inputs ?? {},
    );
    const description = input.description ?? '';
    if (description.length > WORKFLOW_IMPORT_POLICY.maxDescription)
      this.invalid('成果说明超出限制');
    const at = this.clock.now();
    const proposal: WorkflowImportProposal = {
      id: this.clock.id(),
      definitionId: input.definitionId,
      version: input.version,
      versionHash: workflowHash(version),
      revision: 1,
      status: 'DRAFT',
      inputSnapshot,
      description,
      sources: [],
      sourceMetadataHash: workflowHash([]),
      policyVersion: WORKFLOW_IMPORT_POLICY.version,
      createdAt: at,
      updatedAt: at,
      runId: null,
      resolution: {
        suggestedCompletedSteps: [],
        suggestedCurrentStep: version.entryStepId,
        candidateArtifactBindings: [],
        missingRequirements: ['请选择已有成果并核对步骤映射'],
        confidence: 0,
        explanationSummary: '仅根据已选成果和冻结步骤生成建议，未执行任何任务。',
      },
      validationStatus: 'INVALID',
      validationErrors: ['尚无可确认的完成步骤'],
    };
    this.imports.insertProposal(proposal);
    return this.get(proposal.id);
  }

  /** Called only after a Main dialog and existing user-read authority. */
  addSource(id: string, source: WorkflowImportSource): WorkflowImportProposal {
    const current = this.mutable(id);
    if (current.sources.length >= WORKFLOW_IMPORT_POLICY.maxSources)
      this.invalid('最多导入 16 份成果');
    this.assertSource(source);
    this.sources.recheck(source);
    if (
      current.sources.some(
        (s) => s.id === source.id || this.sourceIdentity(s) === this.sourceIdentity(source),
      )
    )
      this.invalid('重复的来源身份，请勿将同一成果冒充多个步骤');
    const version = this.versionFor(current);
    const next = { ...current, sources: [...current.sources, source] };
    const bindings: WorkflowImportRevision['bindings'] = [];
    const completedStepIds: string[] = [];
    const used = new Set<string>();
    let stepId: string | null = version.entryStepId;
    while (stepId) {
      const step = version.steps.find((s) => s.id === stepId)!;
      if (!this.importable(version, step.id)) break;
      const edges: WorkflowVersion['edges'] = version.edges.filter((e) => e.fromStepId === step.id);
      if (
        edges.length !== 1 ||
        edges[0]!.condition.type !== 'ALWAYS' ||
        edges[0]!.revision ||
        !edges[0]!.toStepId
      )
        break;
      const candidate = step.outputs.map((output) => {
        const compatible = next.sources.filter((s) => !used.has(s.id) && s.kind === output.kind);
        const named = compatible.filter((s) => s.name.replace(/\.[^.]+$/, '') === output.key);
        return {
          output,
          source:
            named.length === 1
              ? named[0]
              : step.outputs.length === 1 && compatible.length === 1
                ? compatible[0]
                : undefined,
        };
      });
      if (!candidate.some((c) => c.source) || candidate.some((c) => c.output.required && !c.source))
        break;
      for (const c of candidate)
        if (c.source) {
          bindings.push({ stepId: step.id, outputKey: c.output.key, sourceId: c.source.id });
          used.add(c.source.id);
        }
      completedStepIds.push(step.id);
      stepId = edges[0]!.toStepId;
    }
    return this.persistValidation(next, {
      proposalId: id,
      revision: current.revision,
      completedStepIds,
      currentStepId: stepId ?? version.entryStepId,
      bindings,
    });
  }

  revise(input: WorkflowImportRevision): WorkflowImportProposal {
    const current = this.mutable(input.proposalId, input.revision);
    return this.persistValidation(current, input);
  }

  cancel(input: { proposalId: string; revision: number }): WorkflowImportProposal {
    const current = this.mutable(input.proposalId, input.revision);
    const next = {
      ...current,
      status: 'CANCELLED' as const,
      revision: current.revision + 1,
      updatedAt: this.clock.now(),
    };
    if (!this.imports.saveProposal(next, current.revision)) this.conflict();
    return this.get(current.id);
  }

  confirm(input: { proposalId: string; revision: number }): WorkflowDetail {
    const prior = this.imports.getConfirmationByProposal(input.proposalId);
    if (prior) return this.engine.detail(prior.runId);
    const proposal = this.mutable(input.proposalId, input.revision);
    if (proposal.validationStatus !== 'VALID' || proposal.status !== 'VALIDATED')
      this.invalid('请先修正并验证导入建议');
    const selection: WorkflowImportRevision = {
      proposalId: proposal.id,
      revision: proposal.revision,
      completedStepIds: proposal.resolution.suggestedCompletedSteps,
      currentStepId: proposal.resolution.suggestedCurrentStep!,
      bindings: proposal.resolution.candidateArtifactBindings,
    };
    const errors = this.validate(proposal, selection);
    if (errors.length) this.invalid(errors.join('；'));
    // Recheck within the transaction before committing any durable Run/step facts.
    return this.workflows.transaction(() =>
      this.imports.transaction(() => {
        const fresh = this.mutable(proposal.id, proposal.revision);
        for (const source of fresh.sources) this.sources.recheck(source);
        if (workflowHash(fresh) !== workflowHash(proposal)) this.conflict();
        const detail = this.engine.createRun({
          definitionId: proposal.definitionId,
          version: proposal.version,
          inputs: proposal.inputSnapshot,
        });
        const confirmation: WorkflowImportConfirmation = {
          id: this.clock.id(),
          proposalId: proposal.id,
          runId: detail.run.id,
          versionHash: proposal.versionHash,
          sourceMetadataHash: proposal.sourceMetadataHash,
          completedStepIds: selection.completedStepIds,
          currentStepId: selection.currentStepId,
          bindings: selection.bindings,
          mappingHash: workflowImportMappingHash(
            selection.completedStepIds,
            selection.currentStepId,
            selection.bindings,
          ),
          createdAt: this.clock.now(),
        };
        this.imports.appendConfirmation(confirmation);
        const committed = {
          ...proposal,
          status: 'COMMITTED' as const,
          revision: proposal.revision + 1,
          runId: detail.run.id,
          updatedAt: this.clock.now(),
        };
        if (!this.imports.saveProposal(committed, proposal.revision)) this.conflict();
        this.applyPrefix(detail, proposal, confirmation);
        return this.engine.detail(detail.run.id);
      }),
    );
  }

  private persistValidation(
    current: WorkflowImportProposal,
    input: WorkflowImportRevision,
  ): WorkflowImportProposal {
    const sourceMetadataHash = this.sourceHash(current.sources);
    const candidate = { ...current, sourceMetadataHash };
    const validationErrors = this.validate(candidate, input);
    const next: WorkflowImportProposal = {
      ...candidate,
      revision: current.revision + 1,
      updatedAt: this.clock.now(),
      status: validationErrors.length ? 'DRAFT' : 'VALIDATED',
      validationStatus: validationErrors.length ? 'INVALID' : 'VALID',
      validationErrors,
      resolution: {
        suggestedCompletedSteps: [...input.completedStepIds],
        suggestedCurrentStep: input.currentStepId,
        candidateArtifactBindings: input.bindings.map((b) => ({ ...b })),
        missingRequirements: [...validationErrors],
        confidence: validationErrors.length ? 0 : 1,
        explanationSummary: '确定性检查冻结版本、连续路径与成果合同；确认前不会建立运行事实。',
      },
    };
    if (!this.imports.saveProposal(next, current.revision)) this.conflict();
    return this.get(current.id);
  }

  private validate(proposal: WorkflowImportProposal, input: WorkflowImportRevision): string[] {
    const errors: string[] = [];
    const version = this.versionFor(proposal);
    if (proposal.sourceMetadataHash !== this.sourceHash(proposal.sources))
      errors.push('来源元数据身份不一致');
    if (
      new Set(proposal.sources.map((s) => this.sourceIdentity(s))).size !== proposal.sources.length
    )
      errors.push('重复来源快照');
    if (!input.completedStepIds.length) errors.push('至少需要一个有证据的前序完成步骤');
    if (new Set(input.completedStepIds).size !== input.completedStepIds.length)
      errors.push('完成步骤不可重复');
    if (
      new Set(input.bindings.map((b) => `${b.stepId}:${b.outputKey}`)).size !==
      input.bindings.length
    )
      errors.push('成果映射不可重复');
    if (new Set(input.bindings.map((b) => b.sourceId)).size !== input.bindings.length)
      errors.push('同一成果不能冒充多个步骤产出');
    let next: string | null = version.entryStepId;
    const seen = new Set<string>();
    for (const id of input.completedStepIds) {
      const step = version.steps.find((s) => s.id === id);
      if (!step || id !== next || seen.has(id)) {
        errors.push(`不是连续可达的完成路径：${id}`);
        break;
      }
      if (!this.importable(version, id))
        errors.push(`步骤 ${step.title} 需要真实审核、执行或副作用证据，不能导入完成`);
      if (
        !input.bindings.some(
          (b) => b.stepId === id && proposal.sources.some((s) => s.id === b.sourceId),
        )
      )
        errors.push(`步骤 ${step.title} 缺少真实成果证据`);
      for (const dependency of step.inputs)
        if (
          dependency.required &&
          (!seen.has(dependency.fromStepId) ||
            !input.bindings.some(
              (b) =>
                b.stepId === dependency.fromStepId &&
                b.outputKey === dependency.outputKey &&
                proposal.sources.some((s) => s.id === b.sourceId),
            ))
        )
          errors.push(`缺少依赖：${dependency.key}`);
      for (const output of step.outputs) {
        const binding = input.bindings.find((b) => b.stepId === id && b.outputKey === output.key);
        const source = proposal.sources.find((s) => s.id === binding?.sourceId);
        if (!source) {
          if (output.required || binding) errors.push(`缺少成果：${step.title} / ${output.key}`);
          continue;
        }
        try {
          this.assertSource(source);
          if (source.kind !== output.kind) {
            errors.push(`成果类型不匹配：${output.key}`);
            continue;
          }
          const artifact = this.artifact(
            source,
            output,
            'validation',
            'validation',
            'validation',
            [],
          );
          errors.push(
            ...this.validateArtifact(version, output, artifact).map(
              (code) => `${step.title} / ${output.key}：${code}`,
            ),
          );
          if (version.definition.id === 'official.research')
            errors.push(...this.validateResearchBrief(proposal, source));
        } catch {
          errors.push(`成果身份或内容无效：${source.name}`);
        }
      }
      const edges: WorkflowVersion['edges'] = version.edges.filter((e) => e.fromStepId === id);
      if (edges.length !== 1 || edges[0]!.condition.type !== 'ALWAYS' || edges[0]!.revision) {
        errors.push('只能确认具有单一已声明后继的安全前缀');
        break;
      }
      next = edges[0]!.toStepId;
      seen.add(id);
    }
    if (
      !next ||
      input.currentStepId !== next ||
      seen.has(input.currentStepId) ||
      !version.steps.some((s) => s.id === input.currentStepId)
    )
      errors.push('继续位置不是合法且尚未执行的后继步骤');
    for (const binding of input.bindings)
      if (
        !input.completedStepIds.includes(binding.stepId) ||
        !version.steps
          .find((s) => s.id === binding.stepId)
          ?.outputs.some((o) => o.key === binding.outputKey)
      )
        errors.push('成果映射引用了未确认步骤或不存在的输出');
    return [...new Set(errors)];
  }

  private applyPrefix(
    initial: WorkflowDetail,
    proposal: WorkflowImportProposal,
    confirmation: WorkflowImportConfirmation,
  ): void {
    let run = transitionWorkflowRun(initial.run, 'RUNNING', this.clock.now());
    if (!this.workflows.saveRun(run, initial.run.state)) this.conflict();
    for (const id of confirmation.completedStepIds) {
      let detail = this.engine.detail(run.id);
      let step = detail.steps.find((s) => s.stepId === id)!;
      if (step.state !== 'READY') this.invalid('导入步骤不是当前合法后继');
      const definition = detail.version.steps.find((s) => s.id === id)!;
      const running = {
        ...transitionWorkflowStep(step, 'RUNNING', this.clock.now()),
        completionOrigin: 'IMPORTED_CONFIRMED' as const,
      };
      if (!this.workflows.saveStep(running, step.state)) this.conflict();
      step = running;
      const inputArtifacts: string[] = [];
      for (const dependency of definition.inputs) {
        const producer = detail.steps.find(
          (s) => s.stepId === dependency.fromStepId && s.state === 'COMPLETED',
        );
        const output = detail.bindings.find(
          (b) =>
            b.stepRunId === producer?.id && b.role === 'OUTPUT' && b.key === dependency.outputKey,
        );
        if (!output) {
          if (dependency.required) this.invalid('导入步骤缺少已确认依赖');
          continue;
        }
        inputArtifacts.push(output.artifactId);
        this.imports.appendImportedBinding({
          ...output,
          id: this.clock.id(),
          stepRunId: step.id,
          key: dependency.key,
          role: 'INPUT',
          importConfirmationId: confirmation.id,
          createdAt: this.clock.now(),
        });
      }
      for (const binding of confirmation.bindings.filter((b) => b.stepId === id)) {
        const spec = definition.outputs.find((o) => o.key === binding.outputKey)!;
        const source = proposal.sources.find((s) => s.id === binding.sourceId)!;
        const artifact = this.artifact(
          source,
          spec,
          run.id,
          step.id,
          confirmation.id,
          inputArtifacts,
        );
        this.imports.appendImportedArtifact(artifact);
        this.imports.appendImportedBinding({
          id: this.clock.id(),
          workflowRunId: run.id,
          stepRunId: step.id,
          key: spec.key,
          artifactId: artifact.id,
          role: 'OUTPUT',
          contractId: spec.contractId,
          contractVersion: spec.contractVersion,
          importConfirmationId: confirmation.id,
          createdAt: this.clock.now(),
        });
        this.imports.appendImportedValidation({
          id: this.clock.id(),
          stepRunId: step.id,
          artifactId: artifact.id,
          contractId: spec.contractId,
          contractVersion: spec.contractVersion,
          validatorVersion: this.validatorVersion(detail.version, spec),
          contentHash: artifact.contentHash,
          valid: true,
          errors: [],
          createdAt: this.clock.now(),
        });
      }
      const edge = detail.version.edges.find((e) => e.fromStepId === id)!;
      this.workflows.appendDecision({
        id: this.clock.id(),
        workflowRunId: run.id,
        stepRunId: step.id,
        edgeId: edge.id,
        branch: edge.branch,
        inputHash: workflowHash(confirmation.bindings.filter((b) => b.stepId === id)),
        createdAt: this.clock.now(),
      });
      detail = this.engine.detail(run.id);
      const next = detail.steps.find((s) => s.stepId === edge.toStepId)!;
      if (next.state !== 'PENDING') this.invalid('继续步骤已被执行');
      if (
        !this.workflows.saveStep(
          transitionWorkflowStep(next, 'READY', this.clock.now()),
          next.state,
        )
      )
        this.conflict();
      const states = detail.steps.map((s) =>
        s.id === step.id
          ? { ...s, state: 'COMPLETED' as const }
          : s.id === next.id
            ? { ...s, state: 'READY' as const }
            : s,
      );
      const bindingHashes = detail.bindings.map((b) => workflowHash(b));
      const decisions = detail.decisions.map((d) => workflowHash(d));
      this.workflows.appendCheckpoint({
        id: this.clock.id(),
        workflowRunId: run.id,
        sequence: detail.checkpoints.length + 1,
        definitionVersion: run.definitionVersion,
        completedStepRunIds: states.filter((s) => s.state === 'COMPLETED').map((s) => s.id),
        activeStepRunIds: states
          .filter((s) => ['READY', 'RUNNING', 'WAITING'].includes(s.state))
          .map((s) => s.id),
        artifactBindingHashes: bindingHashes,
        decisionHashes: decisions,
        stateHash: workflowHash({
          states: states.map((s) => ({ id: s.id, state: s.state, missionRunId: s.missionRunId })),
          bindingHashes,
          decisions,
        }),
        createdAt: this.clock.now(),
      });
      if (
        !this.workflows.saveStep(
          transitionWorkflowStep(step, 'COMPLETED', this.clock.now()),
          step.state,
        )
      )
        this.conflict();
      this.workflows.appendEvent({
        id: this.clock.id(),
        workflowRunId: run.id,
        stepRunId: step.id,
        type: 'step.imported_confirmed',
        payload: {
          confirmationId: confirmation.id,
          proposalId: proposal.id,
          origin: 'IMPORTED_CONFIRMED',
        },
        createdAt: this.clock.now(),
      });
    }
    run = this.engine.detail(run.id).run;
    this.workflows.appendEvent({
      id: this.clock.id(),
      workflowRunId: run.id,
      stepRunId: null,
      type: 'workflow.import_confirmed',
      payload: {
        confirmationId: confirmation.id,
        proposalId: proposal.id,
        currentStepId: confirmation.currentStepId,
        sourceMetadataHash: confirmation.sourceMetadataHash,
      },
      createdAt: this.clock.now(),
    });
  }

  private artifact(
    source: WorkflowImportSource,
    spec: WorkflowArtifactSpec,
    runId: string,
    stepId: string,
    confirmationId: string,
    inputs: string[],
  ): WorkflowImportedArtifact {
    const metadata = {
      sourceContentHash: source.contentHash,
      sourceName: source.name,
      snapshot: true,
      sizeBytes: source.size,
      importConfirmationId: confirmationId,
    };
    return {
      id: this.clock.id(),
      workflowRunId: runId,
      producerStepRunId: stepId,
      missionId: null,
      missionRunId: null,
      actorId: null,
      source: 'IMPORTED_CONFIRMED',
      sourceId: source.id,
      importConfirmationId: confirmationId,
      kind: spec.kind,
      content: source.content,
      contentHash: workflowHash({ content: source.content, metadata }),
      metadata,
      inputArtifactIds: inputs,
      createdAt: this.clock.now(),
    };
  }
  private validateArtifact(
    version: WorkflowVersion,
    spec: WorkflowArtifactSpec,
    artifact: WorkflowArtifact,
  ): string[] {
    if (spec.validator.type !== 'REGISTRY') return validateWorkflowArtifact(spec, artifact);
    const contract = version.contractManifest?.find(
      (c) => c.contractId === spec.contractId && c.contractVersion === spec.contractVersion,
    );
    return contract ? validateArtifactContract(contract, artifact) : ['FROZEN_CONTRACT_MISSING'];
  }
  private validatorVersion(version: WorkflowVersion, spec: WorkflowArtifactSpec): string {
    return spec.validator.type === 'REGISTRY'
      ? version.contractManifest!.find(
          (c) => c.contractId === spec.contractId && c.contractVersion === spec.contractVersion,
        )!.validatorVersion
      : W1_VALIDATOR_VERSION;
  }
  private importable(version: WorkflowVersion, id: string): boolean {
    const step = version.steps.find((s) => s.id === id);
    return (
      !!step &&
      step.type === 'TASK' &&
      step.exitCondition === 'VALID_OUTPUTS' &&
      step.effectType === 'NONE' &&
      !step.confirmationRequired &&
      step.outputs.length > 0 &&
      step.outputs.every((o) => ['TEXT', 'JSON'].includes(o.kind)) &&
      !step.executionRequirements?.generation &&
      (version.definition.source === 'USER' ||
        (version.definition.id === 'official.research' &&
          version.version === 1 &&
          step.id === 'R01'))
    );
  }
  private validateResearchBrief(
    proposal: WorkflowImportProposal,
    source: WorkflowImportSource,
  ): string[] {
    try {
      const brief = JSON.parse(source.content) as Record<string, unknown>;
      return brief.researchQuestion === proposal.inputSnapshot.researchQuestion &&
        brief.field === proposal.inputSnapshot.field
        ? []
        : ['科研 brief 与冻结研究问题/领域不一致'];
    } catch {
      return ['科研 brief 必须为有效 JSON'];
    }
  }
  private sourceHash(sources: WorkflowImportSource[]): string {
    return workflowImportSourceMetadataHash(sources);
  }
  private sourceIdentity(source: WorkflowImportSource): string {
    return `${source.workspaceRoot.toLowerCase()}\u0000${source.relativePath.replaceAll('\\', '/').toLowerCase()}`;
  }
  private assertSource(source: WorkflowImportSource): void {
    if (
      !['TEXT', 'JSON'].includes(source.kind) ||
      source.size !== Buffer.byteLength(source.content, 'utf8') ||
      source.size > WORKFLOW_IMPORT_POLICY.maxSourceBytes ||
      source.size < 1 ||
      createHash('sha256').update(source.content, 'utf8').digest('hex') !== source.contentHash
    )
      this.invalid('来源类型、大小或内容身份无效');
    if (source.kind === 'JSON') {
      try {
        JSON.parse(source.content);
      } catch {
        this.invalid('所选 JSON 不是合法结构化内容');
      }
    }
  }
  private versionFor(proposal: WorkflowImportProposal): WorkflowVersion {
    const version = this.requireVersion(proposal.definitionId, proposal.version);
    if (workflowHash(version) !== proposal.versionHash)
      this.invalid('冻结 Workflow 版本身份不一致');
    return version;
  }
  private requireVersion(id: string, version: number): WorkflowVersion {
    const value = this.workflows.getVersion(id, version);
    if (!value) throw new DomainError('NOT_FOUND', '已发布 Workflow 版本不存在');
    validateWorkflowVersion(value);
    return value;
  }
  private mutable(id: string, revision?: number): WorkflowImportProposal {
    const value = this.get(id);
    if (
      ['CANCELLED', 'COMMITTED'].includes(value.status) ||
      (revision !== undefined && value.revision !== revision)
    )
      this.conflict();
    return value;
  }
  private invalid(message: string): never {
    throw new DomainError('WORKFLOW_INPUT_INVALID', message);
  }
  private conflict(): never {
    throw new DomainError('CONFLICT', '导入建议已变化，请重新载入');
  }
}
