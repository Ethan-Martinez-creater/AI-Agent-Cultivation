import type {
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowStepRun,
  WorkflowVersion,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { WorkflowValidationPolicyPort } from '@cultivation/application';

export const RESEARCH_WORKFLOW_DEFINITION_ID = 'official.research';
export const RESEARCH_WORKFLOW_VERSION = 1;
export const RESEARCH_WORKFLOW_VALIDATION_POLICY = 'research-integrity-v1';
export const RESEARCH_EXPERIMENT_REVISION_GROUP = 'research.experiment_cycle';

type Json = Record<string, unknown>;

export interface ResearchSourceArtifactFact {
  workflowRunId: string;
  stepRunId: string;
  sourceArtifactId: string;
  missionId: string;
  missionRunId: string;
  evidenceEventId: string;
  actorId: string;
  toolCallId: string;
  toolId: string;
  url: string;
  contentHash: string;
  outputHash: string;
  kind: 'RESEARCH_TOOL' | 'USER_SOURCE_ARTIFACT';
  attempt: number;
}

export interface ResearchExperimentFact {
  workflowRunId: string;
  stepRunId: string;
  attempt: number;
  missionId: string;
  missionRunId: string;
  actorId: string;
  toolCallId: string;
  toolId: string;
  outputHash: string;
  planArtifactId: string;
  status: 'SUCCEEDED' | 'FAILED';
  method: string;
  negativeResult: boolean;
  rawResults: Array<{ artifactId: string; relativePath: string; contentHash: string }>;
  logArtifactIds: string[];
  /** Optional full hash manifest supplied by the trusted Main workspace observer. */
  files?: Array<{
    sourceArtifactId: string;
    relativePath: string;
    contentHash: string;
    key: 'research.raw_result' | 'research.experiment_log';
  }>;
}

export interface ResearchAcceptedExperimentArtifactFact {
  workflowRunId: string;
  stepRunId: string;
  missionId: string;
  missionRunId: string;
  requestId: string;
  actorId: string;
  artifactId: string;
  relativePath: string;
  contentHash: string;
  targetArtifactId: string;
  state: 'ACCEPTED';
  sourceArtifactId?: string;
}

export interface ResearchFailedExperimentAttemptFact {
  workflowRunId: string;
  stepRunId: string;
  missionId: string;
  missionRunId: string;
  attempt: number;
  outcome: 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  errorCode: string;
  rawPaths: string[];
  rawHashes: string[];
}

/** Durable Main-process facts. Values authored by a model never implement this port. */
export interface ResearchIntegrityFacts {
  listSourceArtifactsForRun(workflowRunId: string): ResearchSourceArtifactFact[];
  listExperimentFactsForStep(stepRunId: string): ResearchExperimentFact[];
  resolveSourceArtifact?(
    workflowRunId: string,
    artifactId: string,
  ): ResearchSourceArtifactFact | undefined;
  listAcceptedExperimentArtifactsForStep?(
    stepRunId: string,
  ): ResearchAcceptedExperimentArtifactFact[];
  listFailedExperimentAttemptsForRun?(workflowRunId: string): ResearchFailedExperimentAttemptFact[];
}

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseObject(value: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError('WORKFLOW_OUTPUT_INVALID', '科研结构化产物不是有效 JSON');
  }
  if (!isObject(parsed))
    throw new DomainError('WORKFLOW_OUTPUT_INVALID', '科研结构化产物必须是对象');
  return parsed;
}

function objectRows(value: unknown): Json[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item)))
    throw new DomainError('WORKFLOW_OUTPUT_INVALID', '科研产物缺少结构化列表');
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length;
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}

function inRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function sameRun(
  detail: WorkflowDetail,
  artifact: WorkflowArtifact | undefined,
): artifact is WorkflowArtifact {
  return artifact !== undefined && artifact.workflowRunId === detail.run.id;
}

function stepForArtifact(
  detail: WorkflowDetail,
  artifact: WorkflowArtifact,
): WorkflowStepRun | undefined {
  return detail.steps.find((step) => step.id === artifact.producerStepRunId);
}

function outputBindings(detail: WorkflowDetail, key: string) {
  return detail.bindings
    .filter(
      (binding) =>
        binding.workflowRunId === detail.run.id && binding.role === 'OUTPUT' && binding.key === key,
    )
    .map((binding) => ({
      binding,
      artifact: detail.artifacts.find((artifact) => artifact.id === binding.artifactId),
    }))
    .filter(
      (entry): entry is { binding: (typeof detail.bindings)[number]; artifact: WorkflowArtifact } =>
        sameRun(detail, entry.artifact),
    )
    .sort((left, right) => {
      const a = stepForArtifact(detail, left.artifact);
      const b = stepForArtifact(detail, right.artifact);
      // Attempt numbers are local to a Step, not comparable across R06/R12 or R11/R13.
      const attemptOrder = a?.stepId === b?.stepId ? (b?.attempt ?? 0) - (a?.attempt ?? 0) : 0;
      return attemptOrder || right.artifact.createdAt.localeCompare(left.artifact.createdAt);
    });
}

function latestOutput(detail: WorkflowDetail, key: string): WorkflowArtifact | undefined {
  return outputBindings(detail, key)[0]?.artifact;
}

function outputForStep(
  detail: WorkflowDetail,
  stepRunId: string,
  key: string,
): WorkflowArtifact | undefined {
  const binding = detail.bindings.find(
    (item) =>
      item.workflowRunId === detail.run.id &&
      item.stepRunId === stepRunId &&
      item.role === 'OUTPUT' &&
      item.key === key,
  );
  const artifact = detail.artifacts.find((item) => item.id === binding?.artifactId);
  return sameRun(detail, artifact) ? artifact : undefined;
}

function inputForStep(
  detail: WorkflowDetail,
  stepRunId: string,
  key: string,
): WorkflowArtifact | undefined {
  const binding = detail.bindings.find(
    (item) =>
      item.workflowRunId === detail.run.id &&
      item.stepRunId === stepRunId &&
      item.role === 'INPUT' &&
      item.key === key,
  );
  const artifact = detail.artifacts.find((item) => item.id === binding?.artifactId);
  return sameRun(detail, artifact) ? artifact : undefined;
}

function producedArtifact(
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  key: string,
): WorkflowArtifact | undefined {
  return produced.find((item) => item.spec.key === key)?.artifact;
}

function requireCurrentMissionArtifact(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  artifact: WorkflowArtifact | undefined,
): artifact is WorkflowArtifact {
  return Boolean(
    artifact &&
      artifact.workflowRunId === detail.run.id &&
      artifact.producerStepRunId === step.id &&
      artifact.missionId === step.missionId &&
      artifact.missionRunId === step.missionRunId &&
      nonEmpty(artifact.actorId) &&
      nonEmpty(artifact.sourceId),
  );
}

function idsAvailable(detail: WorkflowDetail, ids: unknown): ids is string[] {
  return (
    uniqueStrings(ids) &&
    ids.every((id) =>
      detail.artifacts.some(
        (artifact) => artifact.id === id && artifact.workflowRunId === detail.run.id,
      ),
    )
  );
}

function provenanceIdsAvailable(
  detail: WorkflowDetail,
  facts: ResearchIntegrityFacts,
  ids: unknown,
): ids is string[] {
  if (!uniqueStrings(ids)) return false;
  const sourceIds = new Set(
    sourceFactsForRun(facts, detail.run.id).map((fact) => fact.sourceArtifactId),
  );
  const acceptedPacketIds = new Set(
    detail.steps
      .filter((step) => step.stepId === 'R02')
      .flatMap((step) => {
        const packet = outputForStep(detail, step.id, 'research.source_packet');
        return listAcceptedForStep(facts, step.id)
          .filter(
            (fact) =>
              fact.workflowRunId === detail.run.id &&
              fact.stepRunId === step.id &&
              fact.targetArtifactId === 'research.source_packet' &&
              fact.state === 'ACCEPTED' &&
              packet?.source === 'HUMAN_BRIDGE' &&
              packet.metadata.acceptedSourceReport === 1 &&
              packet.metadata.sourceReportId === fact.artifactId &&
              packet.metadata.sourceReportHash === fact.contentHash,
          )
          .map((fact) => fact.sourceArtifactId ?? `source-${fact.contentHash}`);
      }),
  );
  return ids.every(
    (id) =>
      detail.artifacts.some(
        (artifact) => artifact.id === id && artifact.workflowRunId === detail.run.id,
      ) ||
      sourceIds.has(id) ||
      acceptedPacketIds.has(id) ||
      facts.resolveSourceArtifact?.(detail.run.id, id) !== undefined,
  );
}

function sourceFactsForRun(
  facts: ResearchIntegrityFacts,
  runId: string,
): ResearchSourceArtifactFact[] {
  try {
    return facts.listSourceArtifactsForRun(runId);
  } catch {
    return [];
  }
}

function experimentFactsForStep(
  facts: ResearchIntegrityFacts,
  stepRunId: string,
): ResearchExperimentFact[] {
  try {
    return facts.listExperimentFactsForStep(stepRunId);
  } catch {
    return [];
  }
}

function listAcceptedForStep(
  facts: ResearchIntegrityFacts,
  stepRunId: string,
): ResearchAcceptedExperimentArtifactFact[] {
  try {
    return facts.listAcceptedExperimentArtifactsForStep?.(stepRunId) ?? [];
  } catch {
    return [];
  }
}

function failedExperimentFactsForRun(
  facts: ResearchIntegrityFacts,
  workflowRunId: string,
): ResearchFailedExperimentAttemptFact[] {
  try {
    return facts.listFailedExperimentAttemptsForRun?.(workflowRunId) ?? [];
  } catch {
    return [];
  }
}

function parseJsonArtifact(artifact: WorkflowArtifact | undefined): Json {
  if (!artifact) throw new DomainError('WORKFLOW_OUTPUT_INVALID', '科研所需来源产物不存在');
  return parseObject(artifact.content);
}

function sourceRows(detail: WorkflowDetail): Json[] {
  return objectRows(parseJsonArtifact(latestOutput(detail, 'research.literature')).sources);
}

function sourceArtifactFact(
  facts: ResearchIntegrityFacts,
  detail: WorkflowDetail,
  sourceId: unknown,
): ResearchSourceArtifactFact | undefined {
  if (!nonEmpty(sourceId)) return undefined;
  const scoped = sourceFactsForRun(facts, detail.run.id).find(
    (fact) => fact.sourceArtifactId === sourceId && fact.workflowRunId === detail.run.id,
  );
  if (scoped) return scoped;
  return facts.resolveSourceArtifact?.(detail.run.id, sourceId);
}

function existingSourceRefs(detail: WorkflowDetail): Json[] {
  return Array.isArray(detail.run.inputSnapshot?.existingSources)
    ? (detail.run.inputSnapshot!.existingSources as unknown[]).filter(isObject)
    : [];
}

function validateSourceRow(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  currentArtifact: WorkflowArtifact,
  row: Json,
  facts: ResearchIntegrityFacts,
): boolean {
  if (
    !nonEmpty(row.sourceId) ||
    !nonEmpty(row.title) ||
    !Array.isArray(row.authors) ||
    !row.authors.every(nonEmpty) ||
    !inRange(row.year, 1000, 2200) ||
    !nonEmpty(row.source) ||
    !(nonEmpty(row.url) || nonEmpty(row.doi) || nonEmpty(row.identifier)) ||
    !nonEmpty(row.sourceArtifactId) ||
    !nonEmpty(row.sourceContentHash) ||
    !/^[a-f0-9]{64}$/.test(row.sourceContentHash) ||
    !['RESEARCH_TOOL', 'USER_SOURCE_ARTIFACT'].includes(String(row.discoveryMethod))
  )
    return false;
  if (!row.doi && !row.identifier && !row.url) return false;
  const fact = sourceArtifactFact(facts, detail, row.sourceArtifactId);
  if (!fact || fact.url !== row.url || fact.contentHash !== row.sourceContentHash) return false;

  if (row.discoveryMethod === 'RESEARCH_TOOL') {
    return (
      fact.kind === 'RESEARCH_TOOL' &&
      fact.workflowRunId === detail.run.id &&
      fact.stepRunId === step.id &&
      fact.attempt === step.attempt &&
      fact.missionId === step.missionId &&
      fact.missionRunId === step.missionRunId &&
      fact.actorId === currentArtifact.actorId &&
      nonEmpty(fact.evidenceEventId) &&
      nonEmpty(fact.toolCallId) &&
      nonEmpty(fact.toolId) &&
      nonEmpty(fact.outputHash) &&
      (row.discoveryToolId === undefined || row.discoveryToolId === fact.toolId)
    );
  }

  const ref = existingSourceRefs(detail).find((item) => item.id === row.sourceArtifactId);
  return (
    fact.kind === 'USER_SOURCE_ARTIFACT' &&
    ref !== undefined &&
    (ref.contentHash === undefined || ref.contentHash === fact.contentHash) &&
    fact.sourceArtifactId === String(ref.id)
  );
}

function matchesAcceptedPacketSource(source: Json, row: Json): boolean {
  const authors = Array.isArray(source.authors) ? source.authors : [];
  const rowAuthors = Array.isArray(row.authors) ? row.authors : [];
  return (
    source.title === row.title &&
    source.year === row.year &&
    source.source === row.source &&
    source.url === row.url &&
    source.doi === row.doi &&
    source.identifier === row.identifier &&
    JSON.stringify(authors) === JSON.stringify(rowAuthors)
  );
}

function validateAcceptedUserSourceRow(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  row: Json,
  acceptedPackets: ResearchAcceptedExperimentArtifactFact[],
): boolean {
  if (row.discoveryMethod !== 'USER_SOURCE_ARTIFACT' || !nonEmpty(row.sourceArtifactId))
    return false;
  const accepted = acceptedPackets.find(
    (candidate) =>
      candidate.targetArtifactId === 'research.source_packet' &&
      candidate.state === 'ACCEPTED' &&
      candidate.workflowRunId === detail.run.id &&
      candidate.stepRunId === step.id &&
      candidate.missionId === step.missionId &&
      candidate.missionRunId === step.missionRunId &&
      (candidate.sourceArtifactId ?? `source-${candidate.contentHash}`) === row.sourceArtifactId &&
      candidate.contentHash === row.sourceContentHash,
  );
  if (!accepted) return false;
  const packet = producedArtifact(produced, 'research.source_packet');
  if (
    !packet ||
    packet.source !== 'HUMAN_BRIDGE' ||
    packet.workflowRunId !== detail.run.id ||
    packet.producerStepRunId !== step.id ||
    packet.missionId !== step.missionId ||
    packet.missionRunId !== step.missionRunId ||
    packet.metadata.acceptedSourceReport !== 1 ||
    packet.metadata.sourceReportId !== accepted.artifactId ||
    packet.metadata.sourceReportHash !== accepted.contentHash ||
    packet.metadata.targetArtifactId !== 'research.source_packet'
  )
    return false;
  const packetRows = objectRows(parseObject(packet.content).sources);
  return packetRows.some((source) => matchesAcceptedPacketSource(source, row));
}

function validateLiterature(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  facts: ResearchIntegrityFacts,
): string[] {
  const artifact = producedArtifact(produced, 'research.literature');
  if (!requireCurrentMissionArtifact(detail, step, artifact))
    return ['RESEARCH_SOURCE_PACKET_PROVENANCE_INVALID'];
  const data = parseObject(artifact.content);
  const rows = objectRows(data.sources);
  if (rows.length < 1 || rows.length > 20) return ['RESEARCH_SOURCE_REQUIRED'];
  const ids = rows.map((row) => row.sourceId);
  if (!uniqueStrings(ids)) return ['RESEARCH_SOURCE_ID_INVALID'];
  const methods = objectRows(data.searchMethods);
  if (!textList(data.searchLimitations)) return ['RESEARCH_SEARCH_LIMITATIONS_INVALID'];
  const acceptedPackets = listAcceptedForStep(facts, step.id).filter(
    (row) =>
      row.workflowRunId === detail.run.id &&
      row.stepRunId === step.id &&
      row.missionId === step.missionId &&
      row.missionRunId === step.missionRunId &&
      row.state === 'ACCEPTED',
  );
  for (const row of rows)
    if (
      !validateSourceRow(detail, step, artifact, row, facts) &&
      !validateAcceptedUserSourceRow(detail, step, produced, row, acceptedPackets)
    )
      return ['RESEARCH_CITATION_PROVENANCE_INVALID'];
  const methodIds = methods.map((method) => method.methodId);
  if (!uniqueStrings(methodIds)) return ['RESEARCH_SEARCH_METHOD_INVALID'];
  const hasToolSources = rows.some((row) => row.discoveryMethod === 'RESEARCH_TOOL');
  if (hasToolSources && methods.length === 0) return ['RESEARCH_SEARCH_METHOD_REQUIRED'];
  const citedArtifactIds = rows.map((row) => String(row.sourceArtifactId));
  for (const method of methods) {
    const methodSourceArtifactIds = method.sourceArtifactIds;
    if (
      !nonEmpty(method.description) ||
      !uniqueStrings(methodSourceArtifactIds) ||
      methodSourceArtifactIds.length === 0 ||
      methodSourceArtifactIds.some((id) => !citedArtifactIds.includes(id))
    )
      return ['RESEARCH_SEARCH_METHOD_INVALID'];
    if (nonEmpty(method.discoveryToolId)) {
      const toolFacts = sourceFactsForRun(facts, detail.run.id).filter(
        (fact) => fact.kind === 'RESEARCH_TOOL',
      );
      if (
        !toolFacts.some(
          (fact) =>
            fact.toolId === method.discoveryToolId &&
            methodSourceArtifactIds.includes(fact.sourceArtifactId),
        )
      )
        return ['RESEARCH_SEARCH_TOOL_PROVENANCE_INVALID'];
    }
  }
  for (const row of rows.filter((candidate) => candidate.discoveryMethod === 'RESEARCH_TOOL')) {
    const fact = sourceArtifactFact(facts, detail, row.sourceArtifactId);
    if (
      !fact ||
      !methods.some(
        (method) =>
          uniqueStrings(method.sourceArtifactIds) &&
          method.sourceArtifactIds.includes(String(row.sourceArtifactId)) &&
          (method.discoveryToolId === undefined || method.discoveryToolId === fact.toolId),
      )
    )
      return ['RESEARCH_SEARCH_METHOD_SOURCE_MISMATCH'];
  }
  return [];
}

function validateScreeningAndEvidence(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const literature = sourceRows(detail);
  const sourceById = new Map(literature.map((source) => [String(source.sourceId), source]));
  const screening = parseObject(producedArtifact(produced, 'research.screening')?.content ?? '{}');
  const screened = objectRows(screening.sources);
  if (screened.length !== literature.length) return ['RESEARCH_SCREENING_INCOMPLETE'];
  const screenedIds = screened.map((row) => row.sourceId);
  if (!uniqueStrings(screenedIds) || screenedIds.some((id) => !sourceById.has(String(id))))
    return ['RESEARCH_SCREENING_SOURCE_INVALID'];
  for (const row of screened) {
    const source = sourceById.get(String(row.sourceId))!;
    if (
      !['INCLUDED', 'EXCLUDED'].includes(String(row.decision)) ||
      !nonEmpty(row.reason) ||
      !Array.isArray(row.criteria) ||
      !row.criteria.every(nonEmpty) ||
      row.sourceArtifactId !== source.sourceArtifactId
    )
      return ['RESEARCH_SCREENING_REASON_OR_PROVENANCE_REQUIRED'];
  }
  const included = new Set(
    screened.filter((row) => row.decision === 'INCLUDED').map((row) => String(row.sourceId)),
  );
  const evidence = objectRows(
    parseObject(producedArtifact(produced, 'research.evidence')?.content ?? '{}').claims,
  );
  const evidenceIds = evidence.map((row) => row.evidenceId);
  if (!uniqueStrings(evidenceIds)) return ['RESEARCH_EVIDENCE_ID_INVALID'];
  for (const row of evidence) {
    const evidenceStatus = String(row.status);
    const source = sourceById.get(String(row.sourceId));
    if (
      !source ||
      !included.has(String(row.sourceId)) ||
      row.sourceArtifactId !== source.sourceArtifactId ||
      !nonEmpty(row.claim) ||
      !nonEmpty(row.evidence) ||
      !nonEmpty(row.method) ||
      (evidenceStatus === 'EVIDENCE' &&
        (!nonEmpty(row.populationOrDataset) || !nonEmpty(row.metric) || !nonEmpty(row.result))) ||
      (evidenceStatus === 'INFERENCE' && !nonEmpty(row.result)) ||
      !['EVIDENCE', 'INFERENCE', 'UNKNOWN'].includes(String(row.status))
    )
      return ['RESEARCH_EVIDENCE_SOURCE_TRACE_INVALID'];
    if (!Array.isArray(row.limitations) || !row.limitations.every(nonEmpty))
      return ['RESEARCH_EVIDENCE_LIMITATIONS_INVALID'];
  }
  return [];
}

function validateGaps(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const output = parseObject(producedArtifact(produced, 'research.gaps')?.content ?? '{}');
  const evidence = objectRows(
    parseObject(latestOutput(detail, 'research.evidence')?.content ?? '{}').claims,
  );
  const knownIds = new Set(evidence.map((row) => String(row.evidenceId)));
  const gaps = objectRows(output.gaps);
  if (!gaps.length) return ['RESEARCH_GAP_CLASSES_REQUIRED'];
  const evidenceById = new Map(evidence.map((row) => [String(row.evidenceId), row]));
  if (
    gaps.some(
      (row) =>
        !nonEmpty(row.gapId) ||
        !nonEmpty(row.description) ||
        !['EVIDENCE', 'INFERENCE', 'UNKNOWN'].includes(String(row.classification)) ||
        !uniqueStrings(row.evidenceIds) ||
        row.evidenceIds.some((id) => !knownIds.has(String(id))) ||
        (row.classification === 'EVIDENCE' && row.evidenceIds.length === 0) ||
        row.evidenceIds.some((id) => evidenceById.get(id)?.status === 'UNKNOWN') ||
        !nonEmpty(row.rationale) ||
        !nonEmpty(row.uncertainty),
    )
  )
    return ['RESEARCH_GAP_PROVENANCE_INVALID'];
  return [];
}

function validateHypotheses(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const hypotheses = objectRows(
    parseObject(producedArtifact(produced, 'research.hypotheses')?.content ?? '{}').hypotheses,
  );
  const evidenceRows = objectRows(
    parseObject(latestOutput(detail, 'research.evidence')?.content ?? '{}').claims,
  );
  const supportedIds = new Set(
    evidenceRows.filter((row) => row.status === 'EVIDENCE').map((row) => String(row.evidenceId)),
  );
  const contradictingIds = new Set(
    evidenceRows.filter((row) => row.status !== 'UNKNOWN').map((row) => String(row.evidenceId)),
  );
  const ids = hypotheses.map((row) => row.hypothesisId);
  if (!hypotheses.length || !uniqueStrings(ids)) return ['RESEARCH_HYPOTHESIS_REQUIRED'];
  if (
    hypotheses.some(
      (row) =>
        !nonEmpty(row.statement) ||
        !nonEmpty(row.rationale) ||
        !nonEmpty(row.testability) ||
        !nonEmpty(row.proposedEvaluation) ||
        !textList(row.assumptions) ||
        !uniqueStrings(row.supportingEvidenceIds) ||
        !uniqueStrings(row.contradictingEvidenceIds) ||
        row.supportingEvidenceIds.some((id) => !supportedIds.has(id)) ||
        row.contradictingEvidenceIds.some((id) => !contradictingIds.has(id)),
    )
  )
    return ['RESEARCH_HYPOTHESIS_EVIDENCE_INVALID'];
  return [];
}

function actualReviewIndependence(detail: WorkflowDetail, step: WorkflowStepRun): boolean | null {
  const review = outputForStep(detail, step.id, 'research.review');
  if (!review) return null;
  const author =
    step.stepId === 'R06'
      ? latestOutput(detail, 'research.hypotheses')
      : (latestOutput(detail, 'research.revised_manuscript') ??
        latestOutput(detail, 'research.manuscript'));
  if (!author || !nonEmpty(review.actorId) || !nonEmpty(author.actorId)) return null;
  return review.actorId !== author.actorId;
}

/** Derived only from durable artifact actor IDs. Never accepts a model claim. */
export function researchReviewIndependence(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
): boolean | null {
  if (step.stepId !== 'R06' && step.stepId !== 'R12') return null;
  return actualReviewIndependence(detail, step);
}

function validateReview(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  outputKey: string,
): string[] {
  const artifact = producedArtifact(produced, outputKey);
  if (!requireCurrentMissionArtifact(detail, step, artifact))
    return ['RESEARCH_REVIEW_PROVENANCE_INVALID'];
  const review = parseObject(artifact.content);
  const expectedIds =
    step.stepId === 'R06'
      ? [
          inputForStep(detail, step.id, 'hypotheses')?.id ??
            latestOutput(detail, 'research.hypotheses')?.id,
        ]
      : [
          inputForStep(detail, step.id, 'revised_manuscript')?.id ??
            inputForStep(detail, step.id, 'manuscript')?.id ??
            latestOutput(detail, 'research.manuscript')?.id,
          inputForStep(detail, step.id, 'revised_claim_evidence_map')?.id ??
            inputForStep(detail, step.id, 'claim_evidence_map')?.id ??
            latestOutput(detail, 'research.claim_evidence_map')?.id,
          inputForStep(detail, step.id, 'evidence')?.id ??
            latestOutput(detail, 'research.evidence')?.id,
          inputForStep(detail, step.id, 'experiment_record')?.id ??
            latestOutput(detail, 'research.experiment_record')?.id,
          inputForStep(detail, step.id, 'analysis_results')?.id ??
            latestOutput(detail, 'research.analysis_results')?.id,
        ];
  const reviewedArtifactIds = review.reviewedArtifactIds;
  if (
    !['PASS', 'REVISE', 'FAIL'].includes(String(review.verdict)) ||
    !nonEmpty(review.summary) ||
    !textList(review.findings) ||
    !textList(review.evidence) ||
    !uniqueStrings(reviewedArtifactIds) ||
    !idsAvailable(detail, reviewedArtifactIds) ||
    expectedIds.some((id) => !id || !reviewedArtifactIds.includes(id)) ||
    Object.hasOwn(review, 'reviewIndependence')
  )
    return ['RESEARCH_REVIEW_EVIDENCE_INVALID'];
  return [];
}

function validateExperimentPlan(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const plan = parseObject(producedArtifact(produced, 'research.experiment_plan')?.content ?? '{}');
  const hypothesis = parseObject(latestOutput(detail, 'research.hypotheses')?.content ?? '{}');
  const hypothesisIds = objectRows(hypothesis.hypotheses).map((row) =>
    String(row.hypothesisId ?? row.id),
  );
  const mode = detail.run.inputSnapshot?.experimentMode;
  const expectedArtifacts = plan.expectedArtifacts;
  const reproducibilityNotes = plan.reproducibilityNotes;
  const externalExecutionRequirements = plan.externalExecutionRequirements;
  const variables = Array.isArray(plan.variables) ? plan.variables : [];
  const variableIds = variables.filter(isObject).map((row) => row.variableId);
  const metrics = Array.isArray(plan.metrics) ? plan.metrics : [];
  const procedure = Array.isArray(plan.procedure) ? plan.procedure : [];
  if (
    !nonEmpty(plan.hypothesisId) ||
    !hypothesisIds.includes(plan.hypothesisId) ||
    !nonEmpty(plan.method) ||
    !objectRows(plan.variables).length ||
    !uniqueStrings(variableIds) ||
    variables.some((row) => !isObject(row) || !nonEmpty(row.role) || !nonEmpty(row.description)) ||
    !textList(plan.controls) ||
    !textList(plan.baselines) ||
    !objectRows(plan.metrics).length ||
    metrics.some((row) => !nonEmpty(row.name) || !nonEmpty(row.definition)) ||
    !objectRows(plan.procedure).length ||
    procedure.some(
      (row) =>
        !inRange(row.step, 1, 100) || !nonEmpty(row.action) || !nonEmpty(row.expectedObservation),
    ) ||
    !nonEmpty(plan.datasetOrSamples) ||
    !textList(expectedArtifacts) ||
    expectedArtifacts.length === 0 ||
    !textList(plan.failureConditions) ||
    !textList(plan.resourceRequirements) ||
    !textList(reproducibilityNotes) ||
    reproducibilityNotes.length === 0 ||
    !textList(externalExecutionRequirements)
  )
    return ['RESEARCH_EXPERIMENT_PLAN_INCOMPLETE'];
  if (
    mode !== 'COMPUTATIONAL' &&
    textList(externalExecutionRequirements) &&
    externalExecutionRequirements.length === 0
  )
    return ['RESEARCH_EXTERNAL_REQUIREMENT_MISSING'];
  return [];
}

function operationsForStep(detail: WorkflowDetail, step: WorkflowStepRun) {
  return (
    detail.operations?.filter(
      (operation) => operation.stepRunId === step.id && operation.attempt === step.attempt,
    ) ?? []
  );
}

function expectedResearchFilePath(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  key: 'research.raw_result' | 'research.experiment_log',
): string {
  const fileName = key === 'research.raw_result' ? 'raw-result.json' : 'experiment-log.txt';
  return `workflows/${detail.run.id}/${step.id}/research/${fileName}`;
}

function isResearchAttemptPath(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  path: string,
): boolean {
  return (
    path === expectedResearchFilePath(detail, step, 'research.raw_result') ||
    path === expectedResearchFilePath(detail, step, 'research.experiment_log')
  );
}

function validateExperimentRecord(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  facts: ResearchIntegrityFacts,
): string[] {
  const recordArtifact = producedArtifact(produced, 'research.experiment_record');
  if (!requireCurrentMissionArtifact(detail, step, recordArtifact))
    return ['RESEARCH_EXPERIMENT_RECORD_PROVENANCE_INVALID'];
  const record = parseObject(recordArtifact.content);
  const mode = detail.run.inputSnapshot?.experimentMode;
  const plan =
    inputForStep(detail, step.id, 'experiment_plan') ??
    latestOutput(detail, 'research.experiment_plan');
  const operations = operationsForStep(detail, step);
  if (
    !plan ||
    record.mode !== mode ||
    record.planArtifactId !== plan.id ||
    !['COMPLETED', 'FAILED'].includes(String(record.status)) ||
    record.attemptNumber !== step.attempt ||
    !nonEmpty(record.operationKey) ||
    !textList(record.negativeResults) ||
    !textList(record.failureDetails) ||
    !textList(record.limitations) ||
    !textList(record.reproducibilityNotes) ||
    !Array.isArray(record.metrics) ||
    record.metrics.some((item) => !isObject(item)) ||
    operations.length === 0 ||
    operations.some(
      (operation) =>
        operation.workflowRunId !== detail.run.id ||
        !['APPLIED', 'VERIFIED'].includes(operation.state),
    )
  )
    return ['RESEARCH_EXPERIMENT_RECORD_INVALID'];
  const executions = experimentFactsForStep(facts, step.id).filter(
    (fact) =>
      fact.workflowRunId === detail.run.id &&
      fact.stepRunId === step.id &&
      fact.attempt === step.attempt &&
      fact.missionId === step.missionId &&
      fact.missionRunId === step.missionRunId &&
      fact.actorId === recordArtifact.actorId &&
      fact.planArtifactId === plan.id &&
      nonEmpty(fact.toolCallId) &&
      nonEmpty(fact.toolId) &&
      /^[a-f0-9]{64}$/.test(fact.outputHash),
  );
  const accepted = listAcceptedForStep(facts, step.id).filter(
    (fact) =>
      fact.workflowRunId === detail.run.id &&
      fact.stepRunId === step.id &&
      fact.missionId === step.missionId &&
      fact.missionRunId === step.missionRunId &&
      fact.state === 'ACCEPTED',
  );
  const producedFiles = produced.filter(
    (item) =>
      item.spec.key === 'research.raw_result' || item.spec.key === 'research.experiment_log',
  );
  const fileOperations = operations.filter((operation) =>
    ['FILE_OUTPUT', 'WORKSPACE_MUTATION'].includes(operation.effectType),
  );
  const externalOperations = operations.filter(
    (operation) => operation.effectType === 'EXTERNAL_ACTION',
  );
  const expectedEffects =
    mode === 'COMPUTATIONAL'
      ? fileOperations.length === 1 && externalOperations.length === 0 && operations.length === 1
      : mode === 'HUMAN_OR_EXTERNAL'
        ? externalOperations.length === 1 && fileOperations.length === 0 && operations.length === 1
        : mode === 'MIXED'
          ? fileOperations.length === 1 &&
            externalOperations.length === 1 &&
            operations.length === 2
          : false;
  if (!expectedEffects) return ['RESEARCH_EXPERIMENT_EFFECT_RECEIPT_INVALID'];
  if (mode !== 'HUMAN_OR_EXTERNAL' && executions.length !== 1)
    return ['RESEARCH_EXPERIMENT_TOOL_FACT_REQUIRED'];
  if (mode === 'HUMAN_OR_EXTERNAL' && executions.length > 0)
    return ['RESEARCH_EXTERNAL_MODE_HAS_NO_TOOL_AUTHORITY'];
  const execution = executions[0];
  const primaryOperation = mode === 'HUMAN_OR_EXTERNAL' ? externalOperations[0] : fileOperations[0];
  if (!primaryOperation) return ['RESEARCH_EXPERIMENT_EFFECT_RECEIPT_INVALID'];
  const recordNegativeResults = record.negativeResults;
  if (!textList(recordNegativeResults)) return ['RESEARCH_EXPERIMENT_RECORD_INVALID'];
  const recordFile = (key: 'rawResult' | 'experimentLog') => {
    const value = record[key];
    return isObject(value) &&
      nonEmpty(value.relativePath) &&
      /^[a-f0-9]{64}$/.test(String(value.contentHash))
      ? { relativePath: value.relativePath, contentHash: String(value.contentHash) }
      : null;
  };
  const rawRecord = recordFile('rawResult');
  const logRecord = recordFile('experimentLog');
  if (!rawRecord || !logRecord || producedFiles.length !== 2)
    return ['RESEARCH_RAW_RESULT_PROVENANCE_INVALID'];
  const producedByKey = new Map(producedFiles.map(({ spec, artifact }) => [spec.key, artifact]));
  for (const [key, recordValue] of [
    ['research.raw_result', rawRecord],
    ['research.experiment_log', logRecord],
  ] as const) {
    const artifact = producedByKey.get(key);
    const relativePath = artifact?.metadata.relativePath ?? artifact?.metadata.path;
    if (
      !artifact ||
      artifact.workflowRunId !== detail.run.id ||
      artifact.producerStepRunId !== step.id ||
      artifact.missionId !== step.missionId ||
      artifact.missionRunId !== step.missionRunId ||
      relativePath !== recordValue.relativePath ||
      artifact.metadata.contentHash !== recordValue.contentHash ||
      relativePath !== expectedResearchFilePath(detail, step, key)
    )
      return ['RESEARCH_RAW_FILE_HASH_MISMATCH'];
  }
  if (record.operationKey !== primaryOperation.operationKey)
    return ['RESEARCH_OPERATION_KEY_MISMATCH'];

  if (execution) {
    if (
      (record.status === 'COMPLETED'
        ? execution.status !== 'SUCCEEDED'
        : execution.status !== 'FAILED') ||
      execution.method !== parseObject(plan.content).method ||
      !nonEmpty(execution.toolCallId) ||
      !nonEmpty(execution.toolId) ||
      !/^[a-f0-9]{64}$/.test(execution.outputHash)
    )
      return ['RESEARCH_EXPERIMENT_FACT_MISMATCH'];
    const factsByKey = execution.files ?? [];
    const expectedFiles = [
      {
        key: 'research.raw_result',
        relativePath: rawRecord.relativePath,
        contentHash: rawRecord.contentHash,
      },
      {
        key: 'research.experiment_log',
        relativePath: logRecord.relativePath,
        contentHash: logRecord.contentHash,
      },
    ].sort((left, right) => left.key.localeCompare(right.key));
    const durableFiles = factsByKey
      .map(({ key, relativePath, contentHash }) => ({ key, relativePath, contentHash }))
      .sort((left, right) => left.key.localeCompare(right.key));
    if (
      durableFiles.length !== 2 ||
      expectedFiles.some(
        (file, index) =>
          durableFiles[index]?.key !== file.key ||
          durableFiles[index]?.relativePath !== file.relativePath ||
          durableFiles[index]?.contentHash !== file.contentHash,
      )
    )
      return ['RESEARCH_RAW_FILE_HASH_MISMATCH'];
    if (primaryOperation.state === 'VERIFIED') {
      const outputIds = producedFiles.map(({ artifact }) => artifact.id);
      if (outputIds.some((id) => !primaryOperation.outputArtifactIds?.includes(id)))
        return ['RESEARCH_OPERATION_OUTPUT_BINDING_INVALID'];
    } else {
      const manifest = primaryOperation.manifest ?? [];
      if (
        manifest.length !== 2 ||
        expectedFiles.some(
          (file) =>
            !manifest.some(
              (item) =>
                item.relativePath === file.relativePath && item.afterHash === file.contentHash,
            ),
        )
      )
        return ['RESEARCH_OPERATION_MANIFEST_INVALID'];
    }
    if (record.status === 'FAILED' && !textList(record.failureDetails))
      return ['RESEARCH_FAILED_ATTEMPT_DETAILS_REQUIRED'];
    if (execution.negativeResult && recordNegativeResults.length === 0)
      return ['RESEARCH_NEGATIVE_RESULT_REQUIRED'];
  } else {
    const acceptedRawRows = accepted.filter(
      (fact) => fact.targetArtifactId === 'research.raw_result',
    );
    const acceptedLogRows = accepted.filter(
      (fact) => fact.targetArtifactId === 'research.experiment_log',
    );
    const acceptedRecordRows = accepted.filter(
      (fact) => fact.targetArtifactId === 'research.experiment_record',
    );
    const acceptedRaw = acceptedRawRows[0];
    const acceptedLog = acceptedLogRows[0];
    const acceptedRecord = acceptedRecordRows[0];
    if (
      acceptedRawRows.length !== 1 ||
      acceptedLogRows.length !== 1 ||
      acceptedRecordRows.length !== 1 ||
      !acceptedRaw ||
      !acceptedLog ||
      !acceptedRecord ||
      acceptedRaw.requestId !== acceptedLog.requestId ||
      acceptedRaw.requestId !== acceptedRecord.requestId ||
      acceptedRaw.actorId !== acceptedLog.actorId ||
      acceptedRaw.actorId !== acceptedRecord.actorId ||
      acceptedRecord.actorId !== recordArtifact.actorId ||
      // W2 binds the first accepted output in the Mission snapshot; repository
      // ordering is not an output-key guarantee. Require membership in this
      // exact accepted tuple, all from the same request/Run/actor.
      // MIXED's secondary continuation has its own
      // request-id binding below and keeps that durable contract unchanged.
      ![acceptedRaw.artifactId, acceptedLog.artifactId, acceptedRecord.artifactId].includes(
        primaryOperation.externalReference ?? '',
      ) ||
      acceptedRaw.relativePath !== rawRecord.relativePath ||
      acceptedRaw.contentHash !== rawRecord.contentHash ||
      acceptedLog.relativePath !== logRecord.relativePath ||
      acceptedLog.contentHash !== logRecord.contentHash ||
      acceptedRecord.artifactId !== recordArtifact.sourceId ||
      acceptedRecord.targetArtifactId !== recordArtifact.metadata.targetArtifactId ||
      acceptedRecord.contentHash !== recordArtifact.metadata.contentHash
    )
      return ['RESEARCH_ACCEPTED_EXTERNAL_FACT_REQUIRED'];
  }
  if (mode === 'COMPUTATIONAL' && producedFiles.some((item) => item.artifact.source !== 'MISSION'))
    return ['RESEARCH_EXPERIMENT_SOURCE_MISMATCH'];
  if (
    mode === 'HUMAN_OR_EXTERNAL' &&
    producedFiles.some((item) => item.artifact.source !== 'HUMAN_BRIDGE')
  )
    return ['RESEARCH_EXPERIMENT_SOURCE_MISMATCH'];
  if (mode === 'MIXED' && producedFiles.some((item) => item.artifact.source !== 'MISSION'))
    return ['RESEARCH_EXPERIMENT_SOURCE_MISMATCH'];
  if (mode === 'HUMAN_OR_EXTERNAL') {
    if (recordArtifact.source !== 'HUMAN_BRIDGE')
      return ['RESEARCH_HUMAN_MODE_TOOL_EFFECT_FORBIDDEN'];
  }
  if (mode === 'MIXED') {
    const manual = accepted.find((fact) => fact.targetArtifactId === 'research.experiment_record');
    if (
      !manual ||
      externalOperations[0]?.externalReference !== manual.requestId ||
      recordArtifact.metadata.manualArtifactId !== manual.artifactId ||
      recordArtifact.metadata.manualContentHash !== manual.contentHash ||
      recordArtifact.metadata.manualRequestId !== manual.requestId
    )
      return ['RESEARCH_MIXED_ARTIFACT_INVALID'];
    if (recordArtifact.source !== 'MISSION') return ['RESEARCH_MIXED_ARTIFACT_INVALID'];
  }
  return [];
}

function allRunExperimentSteps(
  detail: WorkflowDetail,
  facts?: ResearchIntegrityFacts,
): WorkflowStepRun[] {
  const failedStepIds = new Set(
    facts ? failedExperimentFactsForRun(facts, detail.run.id).map((fact) => fact.stepRunId) : [],
  );
  return detail.steps.filter(
    (step) =>
      step.stepId === 'R08' &&
      step.missionId !== null &&
      (step.state === 'COMPLETED' || failedStepIds.has(step.id)),
  );
}

function recordsForAllAttempts(
  detail: WorkflowDetail,
): Array<{ step: WorkflowStepRun; artifact: WorkflowArtifact; record: Json }> {
  const records: Array<{ step: WorkflowStepRun; artifact: WorkflowArtifact; record: Json }> = [];
  for (const step of allRunExperimentSteps(detail)) {
    const artifact = outputForStep(detail, step.id, 'research.experiment_record');
    if (!artifact || !requireCurrentMissionArtifact(detail, step, artifact)) continue;
    try {
      records.push({ step, artifact, record: parseObject(artifact.content) });
    } catch {
      // Omitted records are caught by the coverage comparison below.
    }
  }
  return records;
}

function validateAnalysis(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  facts: ResearchIntegrityFacts,
): string[] {
  const analysis = producedArtifact(produced, 'research.analysis');
  const results = producedArtifact(produced, 'research.analysis_results');
  if (!analysis || !nonEmpty(analysis.content) || !results) return ['RESEARCH_ANALYSIS_REQUIRED'];
  const data = parseObject(results.content);
  const metrics = objectRows(data.metrics);
  const uncertainty = data.uncertainty;
  const negativeResults = objectRows(data.negativeResults);
  const failedRuns = objectRows(data.failedRuns);
  const limitations = data.limitations;
  if (
    !nonEmpty(data.method) ||
    !metrics.length ||
    !textList(uncertainty) ||
    !textList(limitations) ||
    typeof data.dataComplete !== 'boolean' ||
    typeof data.executionValid !== 'boolean' ||
    !['NONE', 'EXPERIMENT', 'HYPOTHESIS'].includes(String(data.refinementTarget)) ||
    !nonEmpty(data.decisionRationale) ||
    !provenanceIdsAvailable(detail, facts, data.supportingArtifactIds)
  )
    return ['RESEARCH_ANALYSIS_DECISION_SIGNALS_INVALID'];
  const attempts = recordsForAllAttempts(detail);
  const failedFacts = failedExperimentFactsForRun(facts, detail.run.id);
  const recordsByStep = new Set(attempts.map(({ step }) => step.id));
  const failureFactsWithoutRecord = failedFacts.filter(
    (fact) => !recordsByStep.has(fact.stepRunId),
  );
  const failedIds = new Set([
    ...attempts
      .filter(({ record }) => record.status === 'FAILED')
      .map(({ step }) => `${detail.run.id}:R08:${step.attempt}`),
    ...failureFactsWithoutRecord.map((fact) => `${detail.run.id}:R08:${fact.attempt}`),
  ]);
  const negativeIds = new Set(
    attempts
      .filter(
        ({ record }) => Array.isArray(record.negativeResults) && record.negativeResults.length > 0,
      )
      .map(({ step }) => `${detail.run.id}:R08:${step.attempt}`),
  );
  const reportedFailed = new Set(failedRuns.map((row) => String(row.attemptId)));
  const reportedNegative = new Set(negativeResults.map((row) => String(row.attemptId)));
  const expectedNegativePairs = attempts
    .flatMap(({ step, record }) =>
      (Array.isArray(record.negativeResults) ? record.negativeResults : []).map((observation) => ({
        attemptId: `${detail.run.id}:R08:${step.attempt}`,
        observation: String(observation),
      })),
    )
    .map((row) => `${row.attemptId}\0${row.observation}`)
    .sort();
  const actualNegativePairs = negativeResults
    .map((row) => `${String(row.attemptId)}\0${String(row.observation)}`)
    .sort();
  if (
    reportedFailed.size !== failedRuns.length ||
    reportedNegative.size > negativeResults.length ||
    failedRuns.length !== failedIds.size ||
    expectedNegativePairs.join('\0') !== actualNegativePairs.join('\0')
  )
    return ['RESEARCH_ANALYSIS_ATTEMPT_DUPLICATE_OR_OMITTED'];
  if (
    [...failedIds].some((id) => !reportedFailed.has(id)) ||
    [...negativeIds].some((id) => !reportedNegative.has(id))
  )
    return ['RESEARCH_ANALYSIS_OMITTED_FAILED_OR_NEGATIVE_RESULT'];
  if (
    failedRuns.some((row) => !nonEmpty(row.reason) || !failedIds.has(String(row.attemptId))) ||
    negativeResults.some(
      (row) =>
        !nonEmpty(row.metric) ||
        !nonEmpty(row.observation) ||
        !nonEmpty(row.interpretation) ||
        !negativeIds.has(String(row.attemptId)),
    )
  )
    return ['RESEARCH_ANALYSIS_FAILED_OR_NEGATIVE_RESULT_INVALID'];
  const includedMetrics = metrics.flatMap((row) =>
    Array.isArray(row.attemptIds) ? row.attemptIds.map(String) : [],
  );
  const allAttemptIds = [
    ...attempts.map(({ step }) => `${detail.run.id}:R08:${step.attempt}`),
    ...failureFactsWithoutRecord.map((fact) => `${detail.run.id}:R08:${fact.attempt}`),
  ];
  if (
    new Set(allAttemptIds).size !== allAttemptIds.length ||
    allAttemptIds.length !== allRunExperimentSteps(detail, facts).length
  )
    return ['RESEARCH_ANALYSIS_ATTEMPT_DUPLICATE_OR_OMITTED'];
  if (allAttemptIds.some((id) => !includedMetrics.includes(id)) && allAttemptIds.length > 0)
    return ['RESEARCH_ANALYSIS_MISSING_ATTEMPT_METRICS'];
  for (const row of metrics) {
    if (
      !nonEmpty(row.name) ||
      !nonEmpty(row.value) ||
      !nonEmpty(row.uncertainty) ||
      !uniqueStrings(row.attemptIds) ||
      row.attemptIds.some((id) => !allAttemptIds.includes(id)) ||
      !idsAvailable(detail, row.evidenceArtifactIds)
    )
      return ['RESEARCH_ANALYSIS_METRIC_PROVENANCE_INVALID'];
  }
  for (const attempt of attempts) {
    const attemptId = `${detail.run.id}:R08:${attempt.step.attempt}`;
    const negatives = Array.isArray(attempt.record.negativeResults)
      ? attempt.record.negativeResults
      : [];
    for (const negative of negatives) {
      if (
        !negativeResults.some((row) => row.attemptId === attemptId && row.observation === negative)
      )
        return ['RESEARCH_ANALYSIS_OMITTED_NEGATIVE_RESULT'];
    }
  }
  for (const fact of failureFactsWithoutRecord) {
    const failedStep = detail.steps.find((candidate) => candidate.id === fact.stepRunId);
    if (
      fact.workflowRunId !== detail.run.id ||
      !failedStep ||
      failedStep.stepId !== 'R08' ||
      fact.missionId !== failedStep.missionId ||
      fact.missionRunId !== failedStep.missionRunId ||
      fact.attempt !== failedStep.attempt ||
      !['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(fact.outcome) ||
      typeof fact.errorCode !== 'string' ||
      fact.errorCode.length > 128 ||
      !Array.isArray(fact.rawPaths) ||
      !Array.isArray(fact.rawHashes) ||
      fact.rawPaths.length !== fact.rawHashes.length ||
      fact.rawPaths.length > 20 ||
      fact.rawPaths.some(
        (path) => !nonEmpty(path) || !isResearchAttemptPath(detail, failedStep, path),
      ) ||
      fact.rawHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    )
      return ['RESEARCH_FAILED_ATTEMPT_FACT_INVALID'];
  }
  const figuresArtifact = producedArtifact(produced, 'research.figures');
  if (
    !figuresArtifact ||
    figuresArtifact.workflowRunId !== detail.run.id ||
    figuresArtifact.producerStepRunId !== analysis.producerStepRunId
  )
    return ['RESEARCH_FIGURE_PROVENANCE_INVALID'];
  const figureRows = objectRows(parseObject(figuresArtifact.content).figures);
  const figureIds = figureRows.map((row) => row.figureId);
  if (!uniqueStrings(figureIds)) return ['RESEARCH_FIGURE_ID_INVALID'];
  for (const figure of figureRows) {
    if (
      !nonEmpty(figure.title) ||
      !metrics.some((metric) => metric.name === figure.metric) ||
      !uniqueStrings(figure.attemptIds) ||
      figure.attemptIds.length === 0 ||
      figure.attemptIds.some((id) => !allAttemptIds.includes(id)) ||
      !uniqueStrings(figure.evidenceArtifactIds) ||
      !idsAvailable(detail, figure.evidenceArtifactIds) ||
      !Array.isArray(figure.xValues) ||
      !figure.xValues.every(nonEmpty) ||
      !Array.isArray(figure.yValues) ||
      !figure.yValues.every(nonEmpty) ||
      !Array.isArray(figure.labels) ||
      !figure.labels.every(nonEmpty) ||
      figure.xValues.length === 0 ||
      figure.xValues.length !== figure.yValues.length ||
      (figure.labels.length !== 0 && figure.labels.length !== figure.xValues.length)
    )
      return ['RESEARCH_FIGURE_DATA_INVALID'];
  }
  return [];
}

function experimentCyclesUsed(detail: WorkflowDetail): number {
  return (detail.traversals ?? []).filter(
    (row) => row.groupId === RESEARCH_EXPERIMENT_REVISION_GROUP,
  ).length;
}

function deriveEvidenceDecision(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  facts: ResearchIntegrityFacts,
): { branch: string; waitForUser: boolean } {
  const analysisResults =
    inputForStep(detail, step.id, 'analysis_results') ??
    latestOutput(detail, 'research.analysis_results');
  if (!analysisResults) return { branch: 'BLOCKED', waitForUser: true };
  const analysisStep = detail.steps.find(
    (candidate) => candidate.id === analysisResults.producerStepRunId,
  );
  if (!analysisStep || analysisStep.stepId !== 'R09' || analysisStep.state !== 'COMPLETED')
    return { branch: 'BLOCKED', waitForUser: true };
  const analysisOutputs = ['research.analysis', 'research.analysis_results', 'research.figures']
    .map((key) => ({ spec: { key }, artifact: outputForStep(detail, analysisStep.id, key) }))
    .filter((entry): entry is { spec: { key: string }; artifact: WorkflowArtifact } =>
      Boolean(entry.artifact),
    );
  if (
    analysisOutputs.length !== 3 ||
    !analysisOutputs.some((entry) => entry.artifact.id === analysisResults.id) ||
    validateAnalysis(detail, analysisOutputs, facts).length > 0
  )
    return { branch: 'BLOCKED', waitForUser: true };
  let data: Json;
  try {
    data = parseObject(analysisResults.content);
  } catch {
    return { branch: 'BLOCKED', waitForUser: true };
  }
  const signal = data;
  if (
    !signal ||
    typeof signal.dataComplete !== 'boolean' ||
    typeof signal.executionValid !== 'boolean'
  )
    return { branch: 'BLOCKED', waitForUser: true };
  const support = signal.supportingArtifactIds;
  if (!provenanceIdsAvailable(detail, facts, support))
    return { branch: 'BLOCKED', waitForUser: true };
  const attempts = recordsForAllAttempts(detail);
  const failedFacts = failedExperimentFactsForRun(facts, detail.run.id);
  const recordedStepIds = new Set(attempts.map((attempt) => attempt.step.id));
  const failedWithoutRecord = failedFacts.filter((fact) => !recordedStepIds.has(fact.stepRunId));
  if (
    attempts.length + failedWithoutRecord.length !== allRunExperimentSteps(detail, facts).length ||
    attempts.length === 0
  )
    return { branch: 'BLOCKED', waitForUser: true };
  for (const attempt of attempts) {
    const persisted = [
      'research.experiment_record',
      'research.raw_result',
      'research.experiment_log',
    ]
      .map((key) => ({ spec: { key }, artifact: outputForStep(detail, attempt.step.id, key) }))
      .filter((entry): entry is { spec: { key: string }; artifact: WorkflowArtifact } =>
        Boolean(entry.artifact),
      );
    if (
      persisted.length !== 3 ||
      validateExperimentRecord(detail, attempt.step, persisted, facts).length > 0
    )
      return { branch: 'BLOCKED', waitForUser: true };
  }
  if (!signal.dataComplete) return { branch: 'BLOCKED', waitForUser: true };
  const requested = String(signal.refinementTarget);
  if (!['NONE', 'EXPERIMENT', 'HYPOTHESIS'].includes(requested))
    return { branch: 'BLOCKED', waitForUser: true };
  const hasCompletedExperiment = attempts.some(({ record }) => record.status === 'COMPLETED');
  const hasFailedExperiment =
    attempts.some(({ record }) => record.status === 'FAILED') || failedWithoutRecord.length > 0;
  let branch = 'SUFFICIENT';
  if (!signal.executionValid) {
    if (!hasFailedExperiment) return { branch: 'BLOCKED', waitForUser: true };
    branch = 'REFINE_EXPERIMENT';
  } else if (!hasCompletedExperiment) return { branch: 'BLOCKED', waitForUser: true };
  else if (requested === 'EXPERIMENT') branch = 'REFINE_EXPERIMENT';
  else if (requested === 'HYPOTHESIS') {
    const hypotheses = parseObject(latestOutput(detail, 'research.hypotheses')?.content ?? '{}');
    const rows = objectRows(hypotheses.hypotheses);
    const literatureContradiction = rows.some(
      (row) =>
        Array.isArray(row.contradictingEvidenceIds) && row.contradictingEvidenceIds.length > 0,
    );
    const negativeExperiment = attempts.some(({ step: attempt, record }) => {
      if (!Array.isArray(record.negativeResults) || !record.negativeResults.length) return false;
      if (record.mode === 'HUMAN_OR_EXTERNAL')
        return listAcceptedForStep(facts, attempt.id).some(
          (fact) =>
            fact.workflowRunId === detail.run.id &&
            fact.missionRunId === attempt.missionRunId &&
            fact.state === 'ACCEPTED' &&
            fact.targetArtifactId === 'research.experiment_record',
        );
      return facts
        .listExperimentFactsForStep(attempt.id)
        .some(
          (fact) =>
            fact.workflowRunId === detail.run.id &&
            fact.stepRunId === attempt.id &&
            fact.missionRunId === attempt.missionRunId &&
            fact.negativeResult,
        );
    });
    if (!literatureContradiction && !negativeExperiment)
      return { branch: 'BLOCKED', waitForUser: true };
    branch = 'REFINE_HYPOTHESIS';
  }
  if (branch !== 'SUFFICIENT') {
    const limit = detail.run.inputSnapshot?.maxExperimentCycles;
    const maximum = inRange(limit, 1, 2) ? limit : 2;
    if (experimentCyclesUsed(detail) >= maximum) return { branch: 'BLOCKED', waitForUser: true };
  }
  return { branch, waitForUser: branch === 'BLOCKED' };
}

function validateClaimEvidenceMap(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const map = parseObject(
    producedArtifact(produced, 'research.claim_evidence_map')?.content ?? '{}',
  );
  const claims = objectRows(map.claims);
  if (!claims.length) return ['RESEARCH_CLAIM_MAP_REQUIRED'];
  const ids = claims.map((row) => row.claimId);
  if (!uniqueStrings(ids)) return ['RESEARCH_CLAIM_ID_INVALID'];
  const evidenceOutputIds = new Set(
    [
      'research.evidence',
      'research.experiment_record',
      'research.analysis_results',
      'research.raw_result',
    ].flatMap((key) => outputBindings(detail, key).map(({ artifact }) => artifact.id)),
  );
  for (const claim of claims) {
    if (
      !nonEmpty(claim.claim) ||
      !['EVIDENCE', 'INFERENCE', 'UNKNOWN'].includes(String(claim.classification)) ||
      !uniqueStrings(claim.artifactIds) ||
      claim.artifactIds.some(
        (id) =>
          !detail.artifacts.some(
            (artifact) => artifact.id === id && artifact.workflowRunId === detail.run.id,
          ),
      )
    )
      return ['RESEARCH_CLAIM_EVIDENCE_TRACE_INVALID'];
    if (
      claim.classification === 'EVIDENCE' &&
      !claim.artifactIds.some((id) => evidenceOutputIds.has(id))
    )
      return ['RESEARCH_EVIDENCE_CLAIM_UNGROUNDED'];
  }
  return [];
}

function validateRevisionResponse(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
): string[] {
  const response = parseObject(
    producedArtifact(produced, 'research.revision_response')?.content ?? '{}',
  );
  const review = latestOutput(detail, 'research.review');
  const reviewData = review ? parseObject(review.content) : null;
  const responses = objectRows(response.responses);
  const responseFindings = new Set(responses.map((row) => String(row.finding)));
  const findings = reviewData && Array.isArray(reviewData.findings) ? reviewData.findings : [];
  const unresolvedFindings = response.unresolvedFindings;
  if (
    !review ||
    !findings.every((finding) => responseFindings.has(String(finding))) ||
    responseFindings.size !== responses.length ||
    responseFindings.size !== findings.length ||
    !responses.every(
      (row) =>
        nonEmpty(row.finding) &&
        nonEmpty(row.response) &&
        (row.manuscriptSection === '' || nonEmpty(row.manuscriptSection)) &&
        uniqueStrings(row.evidenceArtifactIds) &&
        idsAvailable(detail, row.evidenceArtifactIds),
    ) ||
    !textList(unresolvedFindings) ||
    (textList(unresolvedFindings) &&
      unresolvedFindings.some((finding) => !findings.includes(finding)))
  )
    return ['RESEARCH_REVISION_RESPONSE_INVALID'];
  return [];
}

function validateFinalPackage(
  detail: WorkflowDetail,
  produced: Array<{ spec: { key: string }; artifact: WorkflowArtifact }>,
  facts: ResearchIntegrityFacts,
): string[] {
  const bundle = parseObject(producedArtifact(produced, 'research.final_package')?.content ?? '{}');
  const records = recordsForAllAttempts(detail);
  const expectedRecordIds = records.map(({ artifact }) => artifact.id).sort();
  const outputIds = (key: string) =>
    outputBindings(detail, key)
      .map(({ artifact }) => artifact.id)
      .sort();
  const expectedRawIds = outputIds('research.raw_result');
  const expectedLogIds = outputIds('research.experiment_log');
  const manuscript =
    latestOutput(detail, 'research.revised_manuscript') ??
    latestOutput(detail, 'research.manuscript');
  const evidence = latestOutput(detail, 'research.evidence');
  const screening = latestOutput(detail, 'research.screening');
  const analysis = latestOutput(detail, 'research.analysis');
  const analysisResults = latestOutput(detail, 'research.analysis_results');
  const expectedReviews = outputIds('research.review');
  const expectedClaimMaps = outputIds('research.claim_evidence_map');
  const expectedSources = [
    ...new Set(sourceRows(detail).map((row) => String(row.sourceArtifactId))),
  ].sort();
  const expectedHypotheses = outputIds('research.hypotheses');
  const expectedPlans = outputIds('research.experiment_plan');
  const expectedFigures = outputIds('research.figures');
  const finalReview = latestOutput(detail, 'research.review');
  let finalReviewPassed = false;
  if (finalReview) {
    try {
      finalReviewPassed =
        stepForArtifact(detail, finalReview)?.stepId === 'R12' &&
        parseObject(finalReview.content).verdict === 'PASS';
    } catch {
      finalReviewPassed = false;
    }
  }
  const failedFacts = failedExperimentFactsForRun(facts, detail.run.id);
  const recordedStepIds = new Set(records.map(({ step }) => step.id));
  const unrecordedFailedFacts = failedFacts.filter((fact) => !recordedStepIds.has(fact.stepRunId));
  const expectedAttempts = [
    ...records.map(({ step, artifact, record }) => {
      const raw = isObject(record.rawResult) ? record.rawResult : {};
      const log = isObject(record.experimentLog) ? record.experimentLog : {};
      return {
        stepRunId: step.id,
        missionRunId: step.missionRunId ?? '',
        attempt: step.attempt,
        outcome: record.status,
        recordArtifactId: artifact.id,
        errorCode: step.errorCode ?? '',
        rawPaths: [String(raw.relativePath ?? ''), String(log.relativePath ?? '')],
        rawHashes: [String(raw.contentHash ?? ''), String(log.contentHash ?? '')],
      };
    }),
    ...unrecordedFailedFacts.map((fact) => ({
      stepRunId: fact.stepRunId,
      missionRunId: fact.missionRunId,
      attempt: fact.attempt,
      outcome: fact.outcome,
      recordArtifactId: '',
      errorCode: fact.errorCode,
      rawPaths: fact.rawPaths,
      rawHashes: fact.rawHashes,
    })),
  ].sort(
    (left, right) => left.attempt - right.attempt || left.stepRunId.localeCompare(right.stepRunId),
  );
  const invalidRecordAttempts = records.some(({ step }) => {
    const persisted = [
      'research.experiment_record',
      'research.raw_result',
      'research.experiment_log',
    ]
      .map((key) => ({ spec: { key }, artifact: outputForStep(detail, step.id, key) }))
      .filter((entry): entry is { spec: { key: string }; artifact: WorkflowArtifact } =>
        Boolean(entry.artifact),
      );
    return (
      persisted.length !== 3 || validateExperimentRecord(detail, step, persisted, facts).length > 0
    );
  });
  const actualAttempts = Array.isArray(bundle.experimentAttempts) ? bundle.experimentAttempts : [];
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : isObject(value)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  const serializeAttempts = (rows: unknown[]) => {
    try {
      return JSON.stringify(stable(rows));
    } catch {
      return '';
    }
  };
  const stringsEqual = (actual: unknown, expected: string[]) =>
    uniqueStrings(actual) && [...actual].sort().join('\0') === [...expected].sort().join('\0');
  if (
    !manuscript ||
    bundle.finalManuscriptArtifactId !== manuscript.id ||
    !evidence ||
    bundle.evidenceTableArtifactId !== evidence.id ||
    !screening ||
    bundle.screeningArtifactId !== screening.id ||
    !finalReviewPassed ||
    !analysis ||
    !analysisResults ||
    !stringsEqual(bundle.analysisArtifactIds, [
      ...outputIds('research.analysis'),
      ...outputIds('research.analysis_results'),
    ]) ||
    !Array.isArray(bundle.experimentAttempts) ||
    serializeAttempts(actualAttempts) !== serializeAttempts(expectedAttempts) ||
    !stringsEqual(bundle.rawResultArtifactIds, expectedRawIds) ||
    !stringsEqual(bundle.experimentLogArtifactIds, expectedLogIds) ||
    !stringsEqual(bundle.reviewHistoryArtifactIds, expectedReviews) ||
    !stringsEqual(bundle.claimEvidenceMapArtifactIds, expectedClaimMaps) ||
    !stringsEqual(bundle.sourceArtifactIds, expectedSources) ||
    !stringsEqual(bundle.hypothesisArtifactIds, expectedHypotheses) ||
    !stringsEqual(bundle.experimentPlanArtifactIds, expectedPlans) ||
    !stringsEqual(bundle.figureArtifactIds, expectedFigures) ||
    !nonEmpty(bundle.reproducibilitySummary) ||
    bundle.conclusionStatus !== 'NOT_SCIENTIFICALLY_CONFIRMED' ||
    bundle.submissionStatus !== 'NOT_SUBMITTED'
  )
    return ['RESEARCH_FINAL_PACKAGE_INCOMPLETE'];
  if (
    invalidRecordAttempts ||
    expectedAttempts.length !== allRunExperimentSteps(detail, facts).length ||
    [
      ...expectedRecordIds,
      ...expectedRawIds,
      ...expectedLogIds,
      ...expectedReviews,
      ...expectedClaimMaps,
      ...expectedHypotheses,
      ...expectedPlans,
      ...expectedFigures,
    ].some(
      (id) =>
        !detail.artifacts.some(
          (artifact) => artifact.id === id && artifact.workflowRunId === detail.run.id,
        ),
    ) ||
    !provenanceIdsAvailable(detail, facts, expectedSources) ||
    unrecordedFailedFacts.some((fact) => {
      const step = detail.steps.find((candidate) => candidate.id === fact.stepRunId);
      return (
        fact.workflowRunId !== detail.run.id ||
        !step ||
        step.stepId !== 'R08' ||
        step.missionId !== fact.missionId ||
        step.missionRunId !== fact.missionRunId ||
        step.attempt !== fact.attempt ||
        typeof fact.errorCode !== 'string' ||
        fact.errorCode.length > 128 ||
        !Array.isArray(fact.rawPaths) ||
        !Array.isArray(fact.rawHashes) ||
        fact.rawPaths.length !== fact.rawHashes.length ||
        fact.rawPaths.length > 20 ||
        fact.rawPaths.some(
          (path) => !nonEmpty(path) || !isResearchAttemptPath(detail, step, path),
        ) ||
        fact.rawHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
      );
    })
  )
    return ['RESEARCH_FINAL_PACKAGE_LINEAGE_INVALID'];
  return [];
}

function validateWorkflowIdentity(version: WorkflowVersion): void {
  if (
    version.definition.source !== 'BUILTIN' ||
    version.definition.id !== RESEARCH_WORKFLOW_DEFINITION_ID ||
    version.version !== RESEARCH_WORKFLOW_VERSION ||
    version.validationPolicy !== RESEARCH_WORKFLOW_VALIDATION_POLICY
  )
    throw new DomainError('INVALID_INPUT', '科研完整性策略只适用于 official.research@1');
}

function validDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateResearchLiteratureTimeRange(value: unknown): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new DomainError('WORKFLOW_INPUT_INVALID', '文献时间范围无效');

  const from = value.from;
  const to = value.to;
  if (
    (from !== undefined && !validDateString(from)) ||
    (to !== undefined && !validDateString(to)) ||
    (typeof from === 'string' && typeof to === 'string' && from > to)
  )
    throw new DomainError('WORKFLOW_INPUT_INVALID', '文献时间范围无效');
}

/** Trusted, deterministic provenance/integrity gate registered only by Main code. */
export function researchWorkflowValidationPolicy(
  facts: ResearchIntegrityFacts,
): WorkflowValidationPolicyPort {
  return {
    validateInputs(version, inputs) {
      validateWorkflowIdentity(version);
      if (
        !nonEmpty(inputs.researchQuestion) ||
        !nonEmpty(inputs.field) ||
        !['COMPUTATIONAL', 'HUMAN_OR_EXTERNAL', 'MIXED'].includes(String(inputs.experimentMode)) ||
        (inputs.maxExperimentCycles !== undefined && !inRange(inputs.maxExperimentCycles, 1, 2))
      )
        throw new DomainError(
          'WORKFLOW_INPUT_INVALID',
          '科研问题、领域、实验模式或实验循环上限无效',
        );
      validateResearchLiteratureTimeRange(inputs.literatureTimeRange);
      for (const key of ['existingSources', 'existingData', 'existingCode']) {
        const refs = inputs[key];
        if (refs === undefined) continue;
        if (
          !Array.isArray(refs) ||
          refs.length > 20 ||
          refs.some(
            (ref) =>
              !isObject(ref) ||
              Object.keys(ref).some(
                (field) => !['id', 'kind', 'name', 'contentHash'].includes(field),
              ) ||
              !nonEmpty(ref.id) ||
              !nonEmpty(ref.kind),
          )
        )
          throw new DomainError(
            'WORKFLOW_INPUT_INVALID',
            '已有资料只能以受限 ArtifactRef 元数据提供',
          );
      }
    },
    validateStep(detail, step, produced) {
      try {
        validateWorkflowIdentity(detail.version);
        if (
          detail.run.definitionId !== RESEARCH_WORKFLOW_DEFINITION_ID ||
          detail.run.definitionVersion !== RESEARCH_WORKFLOW_VERSION ||
          step.workflowRunId !== detail.run.id ||
          !detail.version.steps.some((definition) => definition.id === step.stepId)
        )
          return ['RESEARCH_RUN_VERSION_MISMATCH'];
        for (const { artifact } of produced) {
          if (
            artifact.workflowRunId !== detail.run.id ||
            artifact.producerStepRunId !== step.id ||
            artifact.missionId !== step.missionId ||
            artifact.missionRunId !== step.missionRunId ||
            !nonEmpty(artifact.actorId)
          )
            return ['RESEARCH_ARTIFACT_PROVENANCE_INVALID'];
        }
        switch (step.stepId) {
          case 'R01': {
            const brief = parseObject(
              producedArtifact(produced, 'research.brief')?.content ?? '{}',
            );
            const definitions = Array.isArray(brief.definitions) ? brief.definitions : [];
            if (
              !nonEmpty(brief.researchQuestion) ||
              !nonEmpty(brief.field) ||
              (brief.scope !== undefined && typeof brief.scope !== 'string') ||
              !Array.isArray(brief.definitions) ||
              definitions.some(
                (item) => !isObject(item) || !nonEmpty(item.term) || !nonEmpty(item.definition),
              ) ||
              !textList(brief.constraints) ||
              !textList(brief.successCriteria) ||
              !textList(brief.knownAssumptions)
            )
              return ['RESEARCH_BRIEF_INCOMPLETE'];
            return [];
          }
          case 'R02':
            return validateLiterature(detail, step, produced, facts);
          case 'R03':
            return validateScreeningAndEvidence(detail, produced);
          case 'R04':
            return validateGaps(detail, produced);
          case 'R05':
            return validateHypotheses(detail, produced);
          case 'R06':
            return validateReview(detail, step, produced, 'research.review');
          case 'R07':
            return validateExperimentPlan(detail, produced);
          case 'R08':
            return validateExperimentRecord(detail, step, produced, facts);
          case 'R09':
            return validateAnalysis(detail, produced, facts);
          case 'R11':
            return validateClaimEvidenceMap(detail, produced);
          case 'R12':
            return validateReview(detail, step, produced, 'research.review');
          case 'R13':
            return [
              ...validateRevisionResponse(detail, produced),
              ...validateClaimEvidenceMap(detail, produced),
            ];
          case 'R14':
            return validateFinalPackage(detail, produced, facts);
          case 'R10':
            return ['DECISION_STEP_MUST_NOT_CREATE_MODEL_OUTPUT'];
          default:
            return ['RESEARCH_STEP_UNDECLARED'];
        }
      } catch (error) {
        return [error instanceof DomainError ? error.code : 'RESEARCH_OUTPUT_INVALID'];
      }
    },
    decisionBranch(detail, step) {
      if (step.stepId !== 'R10')
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '科研策略收到非 R10 决策步骤');
      return deriveEvidenceDecision(detail, step, facts);
    },
  };
}
