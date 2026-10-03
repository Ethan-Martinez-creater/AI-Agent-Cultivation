import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import type { WorkflowDetail } from '@cultivation/domain';
import type { WorkflowRepository } from '@cultivation/application';
import type {
  MissionCompletionBoundary,
  Gate3MissionStore,
} from '@cultivation/application/gate3-mission-service';
import type { ExternalWorkService } from '@cultivation/application/r2-human-bridge-service';
import { FileWorkspace } from './file-workspace.js';
import { latestSoftwareOutput, type SoftwareVerificationFacts } from './w22-validation-policy.js';
import { softwareExternalDraft } from './w22-execution-contract.js';

type Row = Record<string, unknown>;
function rows(content: string, key: string): Row[] {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (!Array.isArray(value[key]) || value[key].length > 20)
    throw new DomainError('WORKFLOW_OUTPUT_INVALID', '验收记录无效');
  return value[key] as Row[];
}
function acceptance(detail: WorkflowDetail) {
  return rows(latestSoftwareOutput(detail, 'software.acceptance')!.content, 'criteria');
}
function current(workflows: WorkflowRepository, missionId: string) {
  const step = workflows.findStepByMissionId(missionId);
  const detail = step && workflows.detail(step.workflowRunId);
  if (
    !step ||
    !detail ||
    detail.version.definition.id !== 'official.software-feature' ||
    detail.version.validationPolicy !== 'software-integrity-v1' ||
    step.stepId !== 'S06'
  )
    return null;
  return { step, detail };
}

/** Manual evidence is accepted R2 provenance, never an execution substitute. */
export function softwareManualVerificationFacts(
  workflows: WorkflowRepository,
  externalWork: ExternalWorkService,
) {
  return (stepRunId: string) => {
    const detail = workflows
      .listRuns()
      .map((run) => workflows.detail(run.id))
      .find((item) => item?.steps.some((step) => step.id === stepRunId));
    const step = detail?.steps.find((item) => item.id === stepRunId);
    if (!step || !detail || !step.missionId || !step.missionRunId) return [];
    const criterionIds = acceptance(detail)
      .filter((item) => ['MANUAL', 'INSPECTION'].includes(String(item.verificationMethod)))
      .map((item) => String(item.id));
    return externalWork
      .listExternalWorkRequests(step.missionId, step.missionRunId)
      .filter((request) => request.state === 'ACCEPTED')
      .flatMap((request) =>
        externalWork
          .getExternalWorkRequest(request.id)!
          .artifacts.filter(
            (artifact) =>
              artifact.submittedAt === request.submittedAt &&
              artifact.metadataJson.targetArtifactId === 'software.tests',
          )
          .map((artifact) => ({
            requestId: request.id,
            missionId: request.missionId,
            missionRunId: request.runId,
            assigneeId: request.assigneeTeammateId,
            criterionIds,
            acceptedArtifactId: artifact.id,
            acceptedArtifactHash: String(artifact.metadataJson.contentHash),
          })),
      );
  };
}

/** One bounded handoff; command execution is already committed before this seam. */
export function softwareMixedVerificationBoundary(
  workflows: WorkflowRepository,
  missions: Gate3MissionStore,
  externalWork: ExternalWorkService,
  workspaceRoot: () => string | null,
  facts: SoftwareVerificationFacts,
): MissionCompletionBoundary {
  return {
    prepare(mission, run) {
      const context = current(workflows, mission.id);
      if (!context || mission.mode !== 'SOLO') return null;
      const { detail, step } = context;
      const criteria = acceptance(detail);
      const manual = criteria.filter((c) => c.verificationMethod !== 'COMMAND');
      const plan = latestSoftwareOutput(detail, 'software.plan_scope');
      const requiredCommands = plan
        ? rows(plan.content, 'commands').some((c) => c.required === true)
        : false;
      if (
        !manual.length ||
        (!criteria.some((c) => c.verificationMethod === 'COMMAND') && !requiredCommands)
      )
        return null;
      if (step.missionRunId !== run.id)
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '自动验收与 Step Run 绑定不一致');
      const draft = softwareExternalDraft(detail, step);
      return {
        stepRunId: step.id,
        draft: {
          ...draft,
          capability: 'CODING',
          title: '人工验收',
          prompt: `仅核对以下人工验收项：${JSON.stringify(manual)}。命令结果由 Main 读取真实工具事实，你的交付不能代替命令执行。\n${draft.prompt}`,
          requirements: manual.map((c) => String(c.statement)),
          acceptanceCriteria: [
            '逐项记录人工检查的 PASS / FAIL / NOT_RUN 与证据。',
            '命令结论以实际 Tool/MCP 执行记录为准。',
          ],
        },
      };
    },
    async compose(continuation) {
      const context = current(workflows, continuation.missionId);
      if (!context || context.step.missionRunId !== continuation.runId)
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '人工验收与当前 S06 不匹配');
      const { step, detail } = context;
      const marker = missions
        .listMissionEvents(continuation.missionId)
        .find(
          (event) =>
            event.runId === continuation.runId &&
            event.eventType === 'workflow.verification.manual_requested' &&
            event.payloadJson.requestId === continuation.requestId &&
            event.payloadJson.stepRunId === step.id,
        );
      const request = externalWork.getExternalWorkRequest(continuation.requestId);
      const root = workspaceRoot();
      if (
        !marker ||
        !request ||
        request.request.state !== 'ACCEPTED' ||
        !root ||
        root !== detail.run.inputSnapshot?.workspaceRoot ||
        request.request.runId !== continuation.runId
      )
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '人工验收来源无效');
      const artifact = request.artifacts.find(
        (a) =>
          a.submittedAt === request.request.submittedAt &&
          a.metadataJson.targetArtifactId === 'software.tests',
      );
      if (!artifact) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '缺少人工验收报告');
      const bytes = await (
        await FileWorkspace.open(root)
      ).readArtifactBytes(artifact.path, 1_000_000);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== artifact.metadataJson.contentHash || bytes.length !== artifact.sizeBytes)
        throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '已验收文件被修改');
      const manualRows = rows(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'criteria');
      const actual = facts
        .listForStep(step.id)
        .filter(
          (fact) =>
            fact.workflowRunId === detail.run.id &&
            fact.stepRunId === step.id &&
            fact.missionId === step.missionId &&
            fact.missionRunId === continuation.runId,
        );
      const commands = rows(
        latestSoftwareOutput(detail, 'software.plan_scope')!.content,
        'commands',
      );
      const executions = actual
        .filter((fact) =>
          commands.some((c) => c.id === fact.commandId && c.command === fact.command),
        )
        .map((fact) => ({
          commandId: fact.commandId,
          command: fact.command,
          toolId: fact.toolId,
          toolExecutionId: fact.id,
          exitStatus: fact.exitStatus,
          acceptanceCriteriaIds: fact.criterionIds,
          outputArtifactId: fact.id,
          outputHash: fact.outputHash,
        }));
      const criteria = acceptance(detail).map((criterion) => {
        if (criterion.verificationMethod === 'COMMAND') {
          const evidence = executions.filter(
            (e) =>
              e.commandId === criterion.commandId &&
              e.acceptanceCriteriaIds.includes(String(criterion.id)),
          );
          return {
            criterionId: criterion.id,
            status: !evidence.length
              ? 'NOT_RUN'
              : evidence.some((e) => e.exitStatus !== 0)
                ? 'FAIL'
                : 'PASS',
            evidenceArtifactIds: evidence.map((e) => e.outputArtifactId),
            executionIds: evidence.map((e) => e.toolExecutionId),
          };
        }
        const row = manualRows.find((r) => r.criterionId === criterion.id);
        return {
          criterionId: criterion.id,
          status: ['PASS', 'FAIL', 'NOT_RUN'].includes(String(row?.status))
            ? row!.status
            : 'NOT_RUN',
          evidenceArtifactIds: row ? [artifact.id] : [],
          executionIds: [],
        };
      });
      return JSON.stringify({
        executions,
        criteria,
        failures: executions
          .filter((e) => e.exitStatus !== 0)
          .map((e) => ({
            executionId: e.toolExecutionId,
            criterionIds: e.acceptanceCriteriaIds,
            summary: '实际验证命令返回非零状态',
          })),
      });
    },
  };
}
