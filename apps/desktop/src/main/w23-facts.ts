import type { WorkflowRepository } from '@cultivation/application';
import type { Gate3MissionStore } from '@cultivation/application/gate3-mission-service';
import { ResearchSourceRepository } from '@cultivation/persistence';
import type { ResearchIntegrityFacts } from './w23-validation-policy.js';
import type { ExternalWorkService } from '@cultivation/application/r2-human-bridge-service';

/** No network/model calls. Durable permission-gated events are the only Tool facts. */
export function researchIntegrityFacts(
  workflows: WorkflowRepository,
  missions: Gate3MissionStore,
  sources: ResearchSourceRepository,
  externalWork: ExternalWorkService,
): ResearchIntegrityFacts {
  const context = (stepRunId: string) => {
    for (const run of workflows.listRuns()) {
      const detail = workflows.detail(run.id)!;
      const step = detail.steps.find((item) => item.id === stepRunId);
      if (step) return { detail, step };
    }
    return null;
  };
  return {
    listFailedExperimentAttemptsForRun(workflowRunId) {
      const detail = workflows.detail(workflowRunId);
      if (!detail || detail.version.definition.id !== 'official.research') return [];
      return detail.steps
        .filter((step) => step.stepId === 'R08' && step.missionId)
        .flatMap((step) =>
          missions.listRuns(step.missionId!).flatMap((run) => {
            const invalidOutput =
              run.status === 'COMPLETED' &&
              step.state === 'FAILED' &&
              step.missionRunId === run.id &&
              detail.events.some(
                (event) => event.stepRunId === step.id && event.type === 'step.validation_failed',
              );
            if (!['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(run.status) && !invalidOutput)
              return [];
            const events = missions
              .listMissionEvents(step.missionId!)
              .filter((event) => event.runId === run.id);
            const executed =
              events.some((event) =>
                [
                  'model.call_started',
                  'tool.execution_started',
                  'external_work.in_progress',
                ].includes(event.eventType),
              ) ||
              externalWork
                .listExternalWorkRequests(step.missionId!, run.id)
                .some((request) => request.state === 'ACCEPTED');
            if (!executed) return [];
            const files = new Map<string, string>();
            for (const event of events) {
              const payload = event.payloadJson;
              if (
                event.eventType !== 'tool.result' ||
                payload.success !== true ||
                payload.source !== 'MCP' ||
                payload.capability !== 'MCP_TOOL_EXECUTE' ||
                !Array.isArray(payload.artifactFiles)
              )
                continue;
              for (const value of payload.artifactFiles) {
                if (!value || typeof value !== 'object') continue;
                const file = value as Record<string, unknown>;
                if (
                  typeof file.path === 'string' &&
                  file.path.startsWith(`workflows/${workflowRunId}/${step.id}/`) &&
                  typeof file.contentHash === 'string' &&
                  /^[a-f0-9]{64}$/.test(file.contentHash)
                )
                  files.set(file.path, file.contentHash);
              }
            }
            const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
            return [
              {
                workflowRunId,
                stepRunId: step.id,
                missionId: step.missionId!,
                missionRunId: run.id,
                attempt: step.attempt,
                outcome: invalidOutput
                  ? ('FAILED' as const)
                  : (run.status as 'FAILED' | 'CANCELLED' | 'INTERRUPTED'),
                errorCode: run.errorCode ?? step.errorCode ?? '',
                rawPaths: entries.map(([path]) => path),
                rawHashes: entries.map(([, hash]) => hash),
              },
            ];
          }),
        );
    },
    resolveSourceArtifact(workflowRunId, artifactId) {
      const current = sources
        .list(workflowRunId)
        .find((fact) => fact.sourceArtifactId === artifactId);
      if (current)
        return {
          ...current,
          kind: 'RESEARCH_TOOL' as const,
          attempt: context(current.stepRunId)!.step.attempt,
        };
      const detail = workflows.detail(workflowRunId);
      const refs = detail?.run.inputSnapshot?.existingSources;
      if (
        !Array.isArray(refs) ||
        !refs.some(
          (ref) => ref && typeof ref === 'object' && !Array.isArray(ref) && ref.id === artifactId,
        )
      )
        return undefined;
      const prior = sources.resolve(artifactId);
      return prior
        ? {
            ...prior,
            kind: 'USER_SOURCE_ARTIFACT' as const,
            attempt: context(prior.stepRunId)!.step.attempt,
          }
        : undefined;
    },
    listSourceArtifactsForRun(workflowRunId) {
      const detail = workflows.detail(workflowRunId);
      if (!detail || detail.version.definition.id !== 'official.research') return [];
      for (const step of detail.steps.filter(
        (item) => item.stepId === 'R02' && item.missionId && item.missionRunId,
      ))
        for (const event of missions.listMissionEvents(step.missionId!)) {
          const payload = event.payloadJson;
          if (
            event.runId !== step.missionRunId ||
            event.eventType !== 'tool.result' ||
            !event.actorId ||
            payload.success !== true ||
            payload.source !== 'MCP' ||
            payload.capability !== 'MCP_TOOL_EXECUTE' ||
            !Array.isArray(payload.researchSources)
          )
            continue;
          for (const source of payload.researchSources) {
            if (!source || typeof source !== 'object') continue;
            const row = source as Record<string, unknown>;
            sources.append({
              workflowRunId,
              stepRunId: step.id,
              sourceArtifactId: `source-${row.contentHash}`,
              missionId: step.missionId!,
              missionRunId: step.missionRunId!,
              evidenceEventId: event.id,
              actorId: event.actorId,
              toolCallId: String(payload.toolCallId),
              toolId: String(payload.toolId),
              url: String(row.url),
              contentHash: String(row.contentHash),
              outputHash: String(payload.outputHash),
            });
          }
        }
      const actual = sources.list(workflowRunId).map((fact) => ({
        ...fact,
        kind: 'RESEARCH_TOOL' as const,
        attempt: detail.steps.find((step) => step.id === fact.stepRunId)!.attempt,
      }));
      const existing = detail.run.inputSnapshot?.existingSources;
      const user = Array.isArray(existing)
        ? existing.flatMap((ref) => {
            if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.id !== 'string')
              return [];
            const fact = sources.resolve(ref.id);
            return fact
              ? [
                  {
                    ...fact,
                    kind: 'USER_SOURCE_ARTIFACT' as const,
                    attempt: context(fact.stepRunId)!.step.attempt,
                  },
                ]
              : [];
          })
        : [];
      return [...actual, ...user];
    },
    listExperimentFactsForStep(stepRunId) {
      const found = context(stepRunId);
      if (!found?.step.missionId || !found.step.missionRunId) return [];
      const { detail, step } = found;
      return missions.listMissionEvents(step.missionId!).flatMap((event) => {
        const payload = event.payloadJson;
        if (
          event.runId !== step.missionRunId ||
          event.eventType !== 'tool.result' ||
          !event.actorId ||
          payload.success !== true ||
          payload.source !== 'MCP' ||
          payload.capability !== 'MCP_TOOL_EXECUTE' ||
          !payload.researchExperiment ||
          typeof payload.researchExperiment !== 'object' ||
          !Array.isArray(payload.artifactFiles)
        )
          return [];
        const experiment = payload.researchExperiment as Record<string, unknown>;
        const files = payload.artifactFiles as { path: string; contentHash: string }[];
        return [
          {
            workflowRunId: detail.run.id,
            stepRunId: step.id,
            attempt: step.attempt,
            missionId: step.missionId!,
            missionRunId: step.missionRunId!,
            actorId: event.actorId,
            toolCallId: String(payload.toolCallId),
            toolId: String(payload.toolId),
            outputHash: String(payload.outputHash),
            planArtifactId: String(experiment.planArtifactId),
            status: experiment.status as 'SUCCEEDED' | 'FAILED',
            method: String(experiment.method),
            negativeResult: Boolean(experiment.negativeResult),
            rawResults: files
              .filter((file) => file.path.endsWith('raw-result.json'))
              .map((file) => ({
                artifactId: `source-${file.contentHash}`,
                relativePath: file.path,
                contentHash: file.contentHash,
              })),
            files: files.map((file) => ({
              sourceArtifactId: `source-${file.contentHash}`,
              relativePath: file.path,
              contentHash: file.contentHash,
              key: file.path.endsWith('raw-result.json')
                ? ('research.raw_result' as const)
                : ('research.experiment_log' as const),
            })),
            logArtifactIds: files
              .filter((file) => file.path.endsWith('experiment-log.txt'))
              .map((file) => `source-${file.contentHash}`),
          },
        ];
      });
    },
    listAcceptedExperimentArtifactsForStep(stepRunId) {
      const found = context(stepRunId);
      if (!found?.step.missionId || !found.step.missionRunId) return [];
      const { detail, step } = found;
      return externalWork
        .listExternalWorkRequests(step.missionId!, step.missionRunId!)
        .filter((request) => request.state === 'ACCEPTED')
        .flatMap((request) =>
          externalWork
            .getExternalWorkRequest(request.id)!
            .artifacts.filter((artifact) => artifact.submittedAt === request.submittedAt)
            .map((artifact) => ({
              workflowRunId: detail.run.id,
              stepRunId: step.id,
              missionId: request.missionId,
              missionRunId: request.runId,
              requestId: request.id,
              actorId: request.assigneeTeammateId,
              artifactId: artifact.id,
              relativePath: artifact.path,
              sourceArtifactId: `source-${artifact.metadataJson.contentHash}`,
              contentHash: String(artifact.metadataJson.contentHash),
              targetArtifactId: String(artifact.metadataJson.targetArtifactId),
              state: 'ACCEPTED' as const,
            })),
        );
    },
  };
}
