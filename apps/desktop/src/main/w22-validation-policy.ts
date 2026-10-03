import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import { isSafeWorkflowRelativePath } from '@cultivation/domain';
import type { WorkflowDetail, WorkflowStepRun, WorkflowArtifact } from '@cultivation/domain';
import type { WorkflowValidationPolicyPort } from '@cultivation/application';
import type { Gate3MissionStore } from '@cultivation/application/gate3-mission-service';
import type { W22WorkspaceMutationRepository } from '@cultivation/persistence';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function parsed(artifact: WorkflowArtifact | undefined): Json {
  if (!artifact) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '缺少已验证的开发产物');
  const value: unknown = JSON.parse(artifact.content);
  if (!object(value)) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '开发产物结构无效');
  return value;
}
export function softwareInputArtifact(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  key: string,
): WorkflowArtifact | undefined {
  const binding = detail.bindings.find(
    (b) => b.stepRunId === step.id && b.role === 'INPUT' && b.key === key,
  );
  return detail.artifacts.find((a) => a.id === binding?.artifactId);
}
export function latestSoftwareOutput(
  detail: WorkflowDetail,
  key: string,
): WorkflowArtifact | undefined {
  const candidates = detail.bindings
    .filter((b) => b.role === 'OUTPUT' && b.key === key)
    .map((b) => detail.artifacts.find((a) => a.id === b.artifactId))
    .filter((a): a is WorkflowArtifact => a !== undefined);
  return candidates.sort((a, b) => {
    const left = detail.steps?.find((s) => s.id === a.producerStepRunId);
    const right = detail.steps?.find((s) => s.id === b.producerStepRunId);
    return (
      (right?.attempt ?? 0) - (left?.attempt ?? 0) || b.createdAt?.localeCompare(a.createdAt) || 0
    );
  })[0];
}
export interface SoftwareVerificationFact {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  attempt: number;
  missionId: string;
  missionRunId: string;
  actorId: string;
  toolCallId: string;
  commandId: string;
  toolId: string;
  command: string;
  commandHash: string;
  exitStatus: number;
  criterionIds: string[];
  outputHash: string;
}
export interface SoftwareManualVerificationFact {
  requestId: string;
  missionId: string;
  missionRunId: string;
  assigneeId: string;
  criterionIds: string[];
  acceptedArtifactId: string;
  acceptedArtifactHash: string;
}
export interface SoftwareVerificationFacts {
  listForStep(stepRunId: string): SoftwareVerificationFact[];
  /** Main resolves this only from an accepted durable ExternalWork request on the S06 Run. */
  listManualForStep?(stepRunId: string): SoftwareManualVerificationFact[];
}
/** Prepared command rows become effective only with their durable actual Tool result. */
export function verifiedSoftwareFacts(
  repository: Pick<W22WorkspaceMutationRepository, 'listVerificationFacts'>,
  missions: Pick<Gate3MissionStore, 'listMissionEvents'>,
): SoftwareVerificationFacts {
  return {
    listForStep: (id) =>
      repository
        .listVerificationFacts(id)
        .filter((fact) =>
          missions
            .listMissionEvents(fact.missionId)
            .some(
              (event) =>
                event.missionId === fact.missionId &&
                event.runId === fact.missionRunId &&
                event.actorType === 'TEAMMATE' &&
                event.actorId === fact.actorId &&
                event.eventType === 'tool.result' &&
                event.payloadJson.success === true &&
                event.payloadJson.source === 'MCP' &&
                event.payloadJson.toolCallId === fact.toolCallId &&
                event.payloadJson.toolId === fact.toolId &&
                event.payloadJson.outputHash === fact.outputHash,
            ),
        ),
  };
}
function list(value: unknown): Json[] {
  if (!Array.isArray(value) || value.some((item) => !object(item)))
    throw new DomainError('WORKFLOW_OUTPUT_INVALID', '开发产物缺少结构化记录');
  return value as Json[];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}
/** Scope is execution input, never a Permission grant. The plan must have passed S04 first. */
export function softwareToolScope(detail: WorkflowDetail) {
  const repo = latestSoftwareOutput(detail, 'software.repo_context');
  const plan = latestSoftwareOutput(detail, 'software.plan_scope');
  const acceptance = latestSoftwareOutput(detail, 'software.acceptance');
  const contextCommands = repo ? list(parsed(repo).commands) : [];
  const planCommands = plan ? list(parsed(plan).commands) : [];
  const review = latestSoftwareOutput(detail, 'software.plan_review');
  const approved =
    review &&
    plan &&
    parsed(review).verdict === 'PASS' &&
    strings(parsed(review).reviewedArtifactIds).includes(plan.id);
  const allowedCommands = approved
    ? planCommands
        .filter((command) =>
          contextCommands.some(
            (source) => source.id === command.id && source.command === command.command,
          ),
        )
        .map((c) => ({
          id: String(c.id),
          command: String(c.command),
          acceptanceCriteriaIds: strings(c.acceptanceCriteriaIds),
        }))
    : [];
  return {
    allowedToolIds: strings(detail.run.inputSnapshot?.allowedToolScope),
    allowedCommands,
    acceptanceIds: acceptance ? list(parsed(acceptance).criteria).map((c) => String(c.id)) : [],
    allowedPathPrefixes: strings(detail.run.inputSnapshot?.targetArea),
    planFiles:
      approved && plan
        ? list(parsed(plan).files)
            .filter((file) => ['CREATE', 'MODIFY'].includes(String(file.action)))
            .map((file) => String(file.relativePath))
        : [],
  };
}

function verificationOutcome(
  detail: WorkflowDetail,
  report: WorkflowArtifact,
  facts: SoftwareVerificationFacts,
): 'PASS' | 'REVISE' | 'BLOCKED' {
  const data = parsed(report);
  const executions = list(data.executions);
  const criteria = list(data.criteria);
  const plan = parsed(latestSoftwareOutput(detail, 'software.plan_scope'));
  const acceptance = parsed(latestSoftwareOutput(detail, 'software.acceptance'));
  const commands = list(plan.commands);
  const declaredCriteria = list(acceptance.criteria);
  const producer = detail.steps?.find((step) => step.id === report.producerStepRunId);
  if (
    !declaredCriteria.length ||
    !producer ||
    producer.stepId !== 'S06' ||
    producer.workflowRunId !== detail.run.id ||
    producer.missionId === null ||
    producer.missionRunId === null ||
    report.workflowRunId !== detail.run.id ||
    report.missionId !== producer.missionId ||
    report.missionRunId !== producer.missionRunId ||
    !report.actorId.trim()
  )
    return 'BLOCKED';

  const actual = facts.listForStep(producer.id);
  const actualForRow = (row: Json) => {
    const candidates = actual.filter((fact) => fact.id === row.toolExecutionId);
    if (candidates.length !== 1) return undefined;
    const fact = candidates[0]!;
    const planned = commands.find(
      (command) => command.id === row.commandId && command.command === row.command,
    );
    const rowCriteria = strings(row.acceptanceCriteriaIds);
    const planCriteria = planned ? strings(planned.acceptanceCriteriaIds) : [];
    if (
      !planned ||
      fact.workflowRunId !== detail.run.id ||
      fact.stepRunId !== producer.id ||
      fact.attempt !== producer.attempt ||
      fact.missionId !== producer.missionId ||
      fact.missionRunId !== producer.missionRunId ||
      fact.actorId !== report.actorId ||
      !fact.toolCallId.trim() ||
      fact.commandId !== row.commandId ||
      fact.toolId !== row.toolId ||
      fact.command !== row.command ||
      fact.commandHash !== sha256(fact.command) ||
      fact.exitStatus !== row.exitStatus ||
      fact.outputHash !== row.outputHash ||
      row.outputArtifactId !== fact.id ||
      rowCriteria.length === 0 ||
      rowCriteria.some((id) => !fact.criterionIds.includes(id) || !planCriteria.includes(id))
    )
      return undefined;
    return fact;
  };
  const matched = new Map<Json, SoftwareVerificationFact>();
  for (const row of executions) {
    const fact = actualForRow(row);
    if (!fact) return 'BLOCKED';
    matched.set(row, fact);
  }
  if (
    executions.some(
      (row) =>
        !commands.some(
          (command) => command.id === row.commandId && command.command === row.command,
        ),
    )
  )
    return 'BLOCKED';

  for (const command of commands.filter((item) => item.required === true)) {
    const row = executions.find(
      (item) => item.commandId === command.id && item.command === command.command,
    );
    if (!row) return 'BLOCKED';
    if (row.exitStatus !== 0) return 'REVISE';
  }

  if (!validCriterionRecords(declaredCriteria, criteria)) return 'BLOCKED';
  const resultByCriterion = new Map(criteria.map((result) => [String(result.criterionId), result]));
  const manualCriteria = declaredCriteria.filter((criterion) => {
    if (criterion.verificationMethod === 'COMMAND') return false;
    const result = resultByCriterion.get(String(criterion.id));
    return (
      criterion.severity === 'BLOCKING' || result?.status === 'PASS' || result?.status === 'FAIL'
    );
  });
  let manualFact: SoftwareManualVerificationFact | undefined;
  if (manualCriteria.length) {
    const requestId = report.metadata.manualRequestId;
    const artifactId =
      report.source === 'HUMAN_BRIDGE' ? report.sourceId : report.metadata.manualArtifactId;
    const artifactHash =
      report.source === 'HUMAN_BRIDGE'
        ? report.metadata.contentHash
        : report.metadata.manualContentHash;
    const manualFacts = facts.listManualForStep?.(producer.id) ?? [];
    const matchedManualFacts = manualFacts.filter(
      (fact) =>
        fact.missionId === producer.missionId &&
        fact.missionRunId === producer.missionRunId &&
        fact.assigneeId.trim().length > 0 &&
        fact.requestId.trim().length > 0 &&
        fact.acceptedArtifactId === artifactId &&
        fact.acceptedArtifactHash === artifactHash &&
        /^[a-f0-9]{64}$/.test(fact.acceptedArtifactHash) &&
        (report.source === 'HUMAN_BRIDGE' || fact.requestId === requestId) &&
        fact.criterionIds.length > 0 &&
        new Set(fact.criterionIds).size === fact.criterionIds.length &&
        manualCriteria.every((criterion) => fact.criterionIds.includes(String(criterion.id))),
    );
    if (matchedManualFacts.length !== 1) return 'BLOCKED';
    manualFact = matchedManualFacts[0]!;
  }

  for (const criterion of declaredCriteria.filter((item) => item.severity === 'BLOCKING')) {
    const result = resultByCriterion.get(String(criterion.id));
    if (!result) return 'BLOCKED';
    if (result.status === 'NOT_RUN') return 'BLOCKED';
  }

  for (const criterion of declaredCriteria) {
    const result = resultByCriterion.get(String(criterion.id))!;
    if (result.status === 'NOT_RUN') {
      if (criterion.verificationMethod === 'COMMAND' && strings(result.executionIds).length > 0)
        return 'BLOCKED';
      continue;
    }
    if (criterion.verificationMethod === 'COMMAND') {
      const commandId = String(criterion.commandId ?? '');
      const ids = strings(result.executionIds);
      const evidenceIds = strings(result.evidenceArtifactIds);
      if (
        !commandId ||
        !ids.length ||
        !evidenceIds.length ||
        new Set(ids).size !== ids.length ||
        new Set(evidenceIds).size !== evidenceIds.length ||
        ids.some((id) => {
          const row = executions.find((item) => item.toolExecutionId === id);
          return (
            !row ||
            row.commandId !== commandId ||
            !strings(row.acceptanceCriteriaIds).includes(String(criterion.id)) ||
            (result.status === 'PASS' && row.exitStatus !== 0) ||
            !matched.has(row)
          );
        }) ||
        evidenceIds.some(
          (id) =>
            !executions.some(
              (row) =>
                row.outputArtifactId === id &&
                ids.includes(String(row.toolExecutionId)) &&
                matched.has(row),
            ),
        )
      )
        return 'BLOCKED';
      if (criterion.severity === 'BLOCKING' && result.status === 'FAIL') return 'REVISE';
    } else {
      if (result.status !== 'PASS' && result.status !== 'FAIL') return 'BLOCKED';
      const evidenceIds = strings(result.evidenceArtifactIds);
      if (!manualFact || !evidenceIds.includes(manualFact.acceptedArtifactId)) return 'BLOCKED';
      if (criterion.severity === 'BLOCKING' && result.status === 'FAIL') return 'REVISE';
    }
  }
  return 'PASS';
}

function validCriterionRecords(declared: Json[], records: Json[]): boolean {
  if (declared.length === 0 || records.length !== declared.length) return false;
  const declaredIds = declared.map((item) => item.id);
  if (
    declaredIds.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(declaredIds).size !== declaredIds.length
  )
    return false;
  const recordIds = records.map((item) => item.criterionId);
  if (
    recordIds.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(recordIds).size !== recordIds.length ||
    recordIds.some((id) => !declaredIds.includes(id))
  )
    return false;
  return records.every((item) => ['PASS', 'FAIL', 'NOT_RUN'].includes(String(item.status)));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasInvalidCommandProvenance(
  detail: WorkflowDetail,
  report: WorkflowArtifact,
  facts: SoftwareVerificationFacts,
): boolean {
  const producer = detail.steps?.find((step) => step.id === report.producerStepRunId);
  const executions = list(parsed(report).executions);
  if (
    !producer ||
    producer.stepId !== 'S06' ||
    producer.workflowRunId !== detail.run.id ||
    producer.missionId === null ||
    producer.missionRunId === null ||
    report.workflowRunId !== detail.run.id ||
    report.missionId !== producer.missionId ||
    report.missionRunId !== producer.missionRunId
  )
    return executions.length > 0;
  const actual = facts.listForStep(producer.id);
  const plan = parsed(latestSoftwareOutput(detail, 'software.plan_scope'));
  const commands = list(plan.commands);
  return executions.some((row) => {
    const candidates = actual.filter((fact) => fact.id === row.toolExecutionId);
    if (candidates.length !== 1) return true;
    const fact = candidates[0]!;
    const command = commands.find(
      (item) => item.id === row.commandId && item.command === row.command,
    );
    const planCriteria = command ? strings(command.acceptanceCriteriaIds) : [];
    const rowCriteria = strings(row.acceptanceCriteriaIds);
    return (
      !command ||
      fact.workflowRunId !== detail.run.id ||
      fact.stepRunId !== producer.id ||
      fact.attempt !== producer.attempt ||
      fact.missionId !== producer.missionId ||
      fact.missionRunId !== producer.missionRunId ||
      fact.actorId !== report.actorId ||
      !fact.toolCallId.trim() ||
      fact.commandId !== row.commandId ||
      fact.toolId !== row.toolId ||
      fact.command !== row.command ||
      fact.commandHash !== sha256(fact.command) ||
      fact.exitStatus !== row.exitStatus ||
      fact.outputHash !== row.outputHash ||
      row.outputArtifactId !== fact.id ||
      rowCriteria.length === 0 ||
      rowCriteria.some((id) => !fact.criterionIds.includes(id) || !planCriteria.includes(id))
    );
  });
}

/** Registered from trusted Main code. Model statements cannot choose verification branches. */
export function softwareWorkflowValidationPolicy(
  facts: SoftwareVerificationFacts,
): WorkflowValidationPolicyPort {
  return {
    validateInputs(version, inputs) {
      if (
        version.definition.source !== 'BUILTIN' ||
        version.validationPolicy !== 'software-integrity-v1'
      )
        throw new DomainError('INVALID_INPUT', '无效的软件开发工作流');
      if (strings(inputs.targetArea).some((path) => !isSafeWorkflowRelativePath(path)))
        throw new DomainError('WORKFLOW_INPUT_INVALID', '允许修改范围必须是 Workspace 相对路径');
    },
    validateStep(detail, step, produced) {
      try {
        const output = (key: string) => produced.find((item) => item.spec.key === key)?.artifact;
        if (step.stepId === 'S01') {
          const repo = parsed(output('software.repo_context'));
          if (
            list(repo.modules).some(
              (module) => module.path !== '.' && !isSafeWorkflowRelativePath(module.path),
            ) ||
            list(repo.commands).some((command) => !isSafeWorkflowRelativePath(command.sourcePath))
          )
            return ['REPOSITORY_PATH_INVALID'];
        }
        if (step.stepId === 'S02') {
          const criteria = list(parsed(output('software.acceptance')).criteria);
          if (
            !criteria.length ||
            new Set(criteria.map((item) => item.id)).size !== criteria.length ||
            !criteria.some((item) => item.severity === 'BLOCKING')
          )
            return ['ACCEPTANCE_CRITERIA_REQUIRED'];
        }
        if (step.stepId === 'S03') {
          const plan = parsed(output('software.plan_scope'));
          const repo = parsed(latestSoftwareOutput(detail, 'software.repo_context'));
          if (
            list(plan.files).some(
              (file) => !isSafeWorkflowRelativePath(file.relativePath) || file.action === 'DELETE',
            )
          )
            return ['UNSUPPORTED_MUTATION'];
          if (
            list(plan.commands).some(
              (command) =>
                !list(repo.commands).some(
                  (source) => source.id === command.id && source.command === command.command,
                ),
            )
          )
            return ['UNCONFIRMED_COMMAND'];
          const criterionIds = list(
            parsed(latestSoftwareOutput(detail, 'software.acceptance')).criteria,
          ).map((item) => item.id);
          if (
            list(plan.files).some((file) =>
              strings(file.acceptanceCriteriaIds).some((id) => !criterionIds.includes(id)),
            ) ||
            list(plan.commands).some((command) =>
              strings(command.acceptanceCriteriaIds).some((id) => !criterionIds.includes(id)),
            )
          )
            return ['UNKNOWN_ACCEPTANCE_CRITERION'];
          if (
            list(plan.commands).some((command) =>
              /\bgit\s+(?:push|merge)\b|\b(?:deploy|publish|release)\b/i.test(
                String(command.command),
              ),
            )
          )
            return ['PUBLISH_ACTION_FORBIDDEN'];
        }
        if (step.stepId === 'S06') {
          const report = output('software.tests');
          if (!report) return ['MISSING_TEST_REPORT'];
          // BLOCKED is a valid report outcome, but a forged execution claim is not a valid fact.
          if (hasInvalidCommandProvenance(detail, report, facts))
            return ['VERIFICATION_PROVENANCE_INVALID'];
          void verificationOutcome(detail, report, facts);
        }
        return [];
      } catch (error) {
        return [error instanceof DomainError ? error.code : 'SOFTWARE_OUTPUT_INVALID'];
      }
    },
    decisionBranch(detail, step) {
      if (step.stepId === 'S07') {
        const report =
          softwareInputArtifact(detail, step, 'test_report') ??
          latestSoftwareOutput(detail, 'software.tests');
        if (!report) return { branch: 'BLOCKED', waitForUser: true };
        const branch = verificationOutcome(detail, report, facts);
        return { branch, waitForUser: branch === 'BLOCKED' };
      }
      if (step.stepId === 'S09') {
        const review =
          softwareInputArtifact(detail, step, 'code_review') ??
          latestSoftwareOutput(detail, 'software.code_review');
        const branch = String(parsed(review).verdict);
        if (!['PASS', 'REVISE', 'FAIL'].includes(branch))
          throw new DomainError('WORKFLOW_OUTPUT_INVALID', '审查结论无效');
        return { branch, waitForUser: branch === 'FAIL' };
      }
      throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '未声明的软件开发决策');
    },
  };
}
