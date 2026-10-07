import type {
  CollaborationArtifact,
  RuntimeProfile,
  Teammate,
  TeammateModelBinding,
} from '@cultivation/domain';
import type { WorkflowRepository } from '@cultivation/application';
import { workflowHash } from '@cultivation/application';
import type { Gate3MissionStore } from '@cultivation/application/gate3-mission-service';
import type { MemoryPreGateContext } from '@cultivation/application/r5-2-memory-pre-gate';
import { buildMemoryEvidenceFacts } from '@cultivation/application/r5-2-memory-pre-gate';
import { DomainError } from '@cultivation/shared';

interface ExecutionSources {
  getTeammate(id: string): Teammate | null;
  getRuntimeProfile(id: string): RuntimeProfile | null;
  getModelBinding(id: string): TeammateModelBinding | null;
  hasValidModelBinding(id: string): boolean;
  listCollaborationArtifacts(missionId: string, runId: string): CollaborationArtifact[];
}

/**
 * Read-only compatibility adapter. No automatic extraction trigger and no Memory,
 * Permission, Skill, Tool or state mutation port exists here.
 */
export function memoryExecutionPreGateContext(
  missions: Pick<Gate3MissionStore, 'getMission' | 'getRun' | 'listMissionEvents'>,
  sources: ExecutionSources,
  workflows: Pick<WorkflowRepository, 'findStepByMissionId' | 'detail'>,
  input: { missionId: string; runId: string; ownerId: string; sourceId: string },
): MemoryPreGateContext {
  const reject = (): never => {
    throw new DomainError('INVALID_INPUT', '提取证据归属或执行事实无效');
  };
  const mission = missions.getMission(input.missionId);
  const run = missions.getRun(input.runId);
  const teammate = sources.getTeammate(input.ownerId);
  const runtime = teammate?.currentRuntimeProfileId
    ? sources.getRuntimeProfile(teammate.currentRuntimeProfileId)
    : null;
  if (
    !mission ||
    !run ||
    run.missionId !== mission.id ||
    run.status !== 'COMPLETED' ||
    !teammate ||
    teammate.status !== 'ACTIVE' ||
    teammate.executorKind !== 'MODEL_RUNTIME' ||
    !runtime ||
    (runtime.executionProtocol ?? 'LANGUAGE') !== 'LANGUAGE'
  )
    return reject();
  const binding = sources.getModelBinding(teammate.id);
  if (
    !binding ||
    binding.runtimeProfileId !== runtime.id ||
    (binding.executionProtocol ?? 'LANGUAGE') !== 'LANGUAGE' ||
    !sources.hasValidModelBinding(teammate.id)
  )
    return reject();
  const events = missions
    .listMissionEvents(mission.id)
    .filter(
      (event) =>
        event.missionId === mission.id &&
        event.runId === run.id &&
        event.actorType === 'TEAMMATE' &&
        event.actorId === teammate.id,
    );
  if (
    !events.some(
      (event) =>
        event.eventType === 'model.call_started' &&
        event.payloadJson.runtimeProfileId === runtime.id,
    ) ||
    !events.some((event) => event.eventType === 'model.call_completed')
  )
    return reject();

  const step = workflows.findStepByMissionId(mission.id);
  if (step) {
    const detail = workflows.detail(step.workflowRunId);
    const definition = detail?.version.steps.find((value) => value.id === step.stepId);
    if (
      !detail ||
      !definition ||
      step.state !== 'COMPLETED' ||
      step.missionId !== mission.id ||
      step.missionRunId !== run.id ||
      !detail.steps.some(
        (value) =>
          value.id === step.id && value.missionId === mission.id && value.missionRunId === run.id,
      ) ||
      detail.run.definitionId !== detail.version.definition.id ||
      detail.run.definitionVersion !== detail.version.version ||
      detail.steps.some((value) => value.stepId === step.stepId && value.attempt > step.attempt)
    )
      return reject();
    const artifact = detail.artifacts.find(
      (value) =>
        value.id === input.sourceId &&
        value.workflowRunId === detail.run.id &&
        value.producerStepRunId === step.id &&
        value.missionId === mission.id &&
        value.missionRunId === run.id &&
        value.actorId === teammate.id &&
        value.source === 'MISSION' &&
        (value.kind === 'TEXT' || value.kind === 'JSON'),
    );
    if (
      !artifact ||
      workflowHash({ content: artifact.content, metadata: artifact.metadata }) !==
        artifact.contentHash
    )
      return reject();
    const binding = detail.bindings.find(
      (value) =>
        value.workflowRunId === detail.run.id &&
        value.stepRunId === step.id &&
        value.artifactId === artifact.id &&
        value.role === 'OUTPUT',
    );
    if (
      !binding ||
      !definition.outputs.some(
        (value) =>
          value.key === binding.key &&
          value.kind === artifact.kind &&
          value.contractId === binding.contractId &&
          value.contractVersion === binding.contractVersion,
      ) ||
      !detail.validations.some(
        (value) =>
          value.stepRunId === step.id &&
          value.artifactId === artifact.id &&
          value.valid &&
          value.contentHash === artifact.contentHash &&
          value.contractId === binding.contractId &&
          value.contractVersion === binding.contractVersion,
      )
    )
      return reject();
    return {
      ownerId: teammate.id,
      sourceId: artifact.id,
      sourceType: 'WORKFLOW_STEP_RESULT',
      trigger: 'HARNESS',
      ...buildMemoryEvidenceFacts(artifact.content),
      execution: {
        objectiveSummary: definition.objective,
        stepType: definition.type,
        requiredCapabilities: (definition.routing.requiredCapabilities ?? []).slice(0, 8),
        inputArtifactSummaries: detail.bindings
          .filter(
            (value) =>
              value.workflowRunId === detail.run.id &&
              value.stepRunId === step.id &&
              value.role === 'INPUT',
          )
          .flatMap((value) => {
            const inputArtifact = detail.artifacts.find(
              (item) => item.id === value.artifactId && item.workflowRunId === detail.run.id,
            );
            return inputArtifact
              ? [{ id: inputArtifact.id, kind: inputArtifact.kind, name: value.key }]
              : [];
          })
          .slice(0, 4),
        expectedOutputContract: definition.outputs
          .slice(0, 4)
          .map(({ key, kind, contractId, contractVersion }) => ({
            key,
            kind,
            contractId,
            contractVersion,
          })),
        publicState: mission.state,
      },
    };
  }
  let evidence: string;
  if (mission.mode === 'SOLO') {
    if (
      mission.coordinatorTeammateId !== teammate.id ||
      input.sourceId !== run.id ||
      !run.resultText
    )
      return reject();
    evidence = run.resultText;
  } else {
    const artifact = sources
      .listCollaborationArtifacts(mission.id, run.id)
      .find(
        (value) =>
          value.id === input.sourceId &&
          value.missionId === mission.id &&
          value.runId === run.id &&
          value.teammateId === teammate.id,
      );
    if (!artifact) return reject();
    evidence = artifact.content;
  }
  return {
    ownerId: teammate.id,
    sourceId: input.sourceId,
    sourceType: 'MISSION_RESULT',
    trigger: 'HARNESS',
    ...buildMemoryEvidenceFacts(evidence),
    execution: { objectiveSummary: mission.objective, publicState: mission.state },
  };
}
