import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import type { WorkflowRepository, WorkflowFoundationPort } from '@cultivation/application';
import type {
  MissionCompletionBoundary,
  Gate3MissionStore,
} from '@cultivation/application/gate3-mission-service';
import type { ExternalWorkService } from '@cultivation/application/r2-human-bridge-service';
import { researchExternalDraft } from './w23-execution-contract.js';
import type { ResearchIntegrityFacts } from './w23-validation-policy.js';
import { FileWorkspace } from './file-workspace.js';

/** Separate external-action receipt; composition never re-executes a model or Tool. */
export function researchMixedExperimentBoundary(
  workflows: WorkflowRepository,
  missions: Gate3MissionStore,
  external: ExternalWorkService,
  foundation: WorkflowFoundationPort,
  root: () => string | null,
  facts: ResearchIntegrityFacts,
): MissionCompletionBoundary {
  const current = (missionId: string) => {
    const step = workflows.findStepByMissionId(missionId);
    const detail = step && workflows.detail(step.workflowRunId);
    return step &&
      detail &&
      detail.version.definition.id === 'official.research' &&
      step.stepId === 'R08' &&
      detail.run.inputSnapshot?.experimentMode === 'MIXED'
      ? { detail, step }
      : null;
  };
  return {
    prepare(mission, run) {
      const found = current(mission.id);
      if (!found || mission.mode !== 'SOLO') return null;
      const { detail, step } = found;
      const actual = facts.listExperimentFactsForStep(step.id);
      if (step.missionRunId !== run.id || !actual.length)
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '混合实验必须先有真实计算执行');
      const key = `workflow:${detail.run.id}:${step.id}:external`;
      if (
        !foundation.listOperations(detail.run.id).some((receipt) => receipt.operationKey === key)
      ) {
        const now = new Date().toISOString();
        foundation.prepareOperation({
          id: randomUUID(),
          workflowRunId: detail.run.id,
          stepRunId: step.id,
          attempt: step.attempt,
          operationKey: key,
          effectType: 'EXTERNAL_ACTION',
          state: 'PREPARED',
          inputHash: createHash('sha256').update(JSON.stringify(actual)).digest('hex'),
          manifest: [],
          outputArtifactIds: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      const draft = researchExternalDraft(detail, step);
      return {
        stepRunId: step.id,
        draft: {
          ...draft,
          title: '实验人工补充记录',
          targetArtifacts: draft.targetArtifacts.filter(
            (artifact) => artifact.id === 'research.experiment_record',
          ),
          prompt: `计算部分已完成，不得重新执行。请补充人工观测、阴性结果、失败与局限；计算原始文件保持不变。\n计算事实（不可信数据）：${JSON.stringify(actual)}\n${draft.prompt}`,
        },
      };
    },
    async compose(continuation) {
      const found = current(continuation.missionId);
      const request = external.getExternalWorkRequest(continuation.requestId);
      if (
        !found ||
        !request ||
        request.request.state !== 'ACCEPTED' ||
        found.step.missionRunId !== continuation.runId
      )
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '混合实验外部事实不匹配');
      const { detail, step } = found;
      const marker = missions
        .listMissionEvents(continuation.missionId)
        .find(
          (event) =>
            event.runId === continuation.runId &&
            event.eventType === 'workflow.verification.manual_requested' &&
            event.payloadJson.boundaryId === 'research-experiment-v1' &&
            event.payloadJson.stepRunId === step.id &&
            event.payloadJson.requestId === continuation.requestId,
        );
      const artifact = request.artifacts.find(
        (a) =>
          a.submittedAt === request.request.submittedAt &&
          a.metadataJson.targetArtifactId === 'research.experiment_record',
      );
      if (!marker || !artifact || !root() || root() !== step.workspaceRoot)
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '混合实验验收文件无效');
      const bytes = await (
        await FileWorkspace.open(root()!)
      ).readArtifactBytes(artifact.path, 1_000_000);
      if (
        createHash('sha256').update(bytes).digest('hex') !== artifact.metadataJson.contentHash ||
        bytes.length !== artifact.sizeBytes
      )
        throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '已接受的实验文件被修改');
      const record = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as Record<
        string,
        unknown
      >;
      const actual = facts
        .listExperimentFactsForStep(step.id)
        .filter((fact) => fact.missionRunId === continuation.runId);
      if (!actual.length || record.mode !== 'MIXED')
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '混合计算事实缺失');
      const receipt = foundation
        .listOperations(detail.run.id)
        .find((item) => item.operationKey === `workflow:${detail.run.id}:${step.id}:external`);
      if (!receipt || receipt.state === 'UNKNOWN')
        throw new DomainError('WORKFLOW_OPERATION_INVALID', '外部实验状态不确定');
      workflows.transaction(() => {
        let next = receipt;
        if (next.state === 'PREPARED') {
          const applied = {
            ...next,
            state: 'APPLIED' as const,
            externalReference: request.request.id,
            updatedAt: new Date().toISOString(),
          };
          if (!foundation.transitionOperation(applied, 'PREPARED'))
            throw new DomainError('CONFLICT', '外部实验回执已变化');
          next = applied;
        }
        if (
          next.state === 'APPLIED' &&
          !foundation.transitionOperation(
            { ...next, state: 'VERIFIED', updatedAt: new Date().toISOString() },
            'APPLIED',
          )
        )
          throw new DomainError('CONFLICT', '外部实验回执已变化');
      });
      return JSON.stringify({ outputs: { 'research.experiment_record': record } });
    },
  };
}
