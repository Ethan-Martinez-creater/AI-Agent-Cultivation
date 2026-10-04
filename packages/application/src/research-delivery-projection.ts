import { createHash } from 'node:crypto';
import type {
  ResearchDeliveryCategory,
  ResearchDeliveryItem,
  ResearchDeliveryOutcome,
  ResearchDeliveryProjection,
  WorkflowArtifact,
  WorkflowArtifactBinding,
  WorkflowDetail,
  WorkflowStepRun,
} from '@cultivation/domain';
import { validateBuiltinWorkflowRelease } from './w2-contracts.js';
import {
  RESEARCH_DEFINITION_ID,
  RESEARCH_PACKAGE,
  RESEARCH_VERSION_1,
} from './builtin/research/v1.js';

export interface ResearchDeliveryProjectionOptions {
  /** Optional independent check against persisted MissionRun output facts. Keep this predicate pure. */
  verifyMissionFact?: (artifact: WorkflowArtifact, producer: WorkflowStepRun) => boolean;
}

interface DeliveryOutput {
  stepId: string;
  key: string;
  category: ResearchDeliveryCategory;
  displayName: string;
}

interface ValidBoundArtifact {
  artifact: WorkflowArtifact;
  producer: WorkflowStepRun;
}

const DELIVERY_OUTPUTS: readonly DeliveryOutput[] = [
  { stepId: 'R01', key: 'research.brief', category: 'brief', displayName: '研究摘要' },
  {
    stepId: 'R03',
    key: 'research.evidence',
    category: 'evidence_table',
    displayName: '证据表',
  },
  { stepId: 'R04', key: 'research.landscape', category: 'landscape', displayName: '研究版图' },
  { stepId: 'R05', key: 'research.hypotheses', category: 'hypotheses', displayName: '研究假设' },
  { stepId: 'R06', key: 'research.review', category: 'scientific_review', displayName: '假设审查' },
  {
    stepId: 'R07',
    key: 'research.experiment_plan',
    category: 'experiment_plan',
    displayName: '实验计划',
  },
  {
    stepId: 'R08',
    key: 'research.experiment_record',
    category: 'experiment_record',
    displayName: '实验记录',
  },
  { stepId: 'R09', key: 'research.analysis', category: 'analysis', displayName: '分析' },
  {
    stepId: 'R09',
    key: 'research.analysis_results',
    category: 'analysis',
    displayName: '分析结果与可复现性信号',
  },
  {
    stepId: 'R12',
    key: 'research.review',
    category: 'scientific_review',
    displayName: '科学审查',
  },
  {
    stepId: 'R14',
    key: 'research.final_package',
    category: 'final_package',
    displayName: '最终研究包',
  },
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Matches the durable W1 hash of { content, metadata } without depending on the service module. */
function artifactEnvelopeHash(artifact: WorkflowArtifact): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ content: artifact.content, metadata: artifact.metadata })))
    .digest('hex');
}

function bindingHash(binding: WorkflowArtifactBinding): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(binding)))
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyProjection(): ResearchDeliveryProjection {
  return { items: [] };
}

function hasFrozenOfficialResearchVersion(detail: WorkflowDetail): boolean {
  if (
    RESEARCH_PACKAGE.kind !== 'OFFICIAL' ||
    detail.run.definitionId !== RESEARCH_DEFINITION_ID ||
    detail.run.definitionVersion !== RESEARCH_VERSION_1.version ||
    detail.version.definition.id !== RESEARCH_DEFINITION_ID ||
    detail.version.definition.source !== 'BUILTIN' ||
    detail.version.version !== RESEARCH_VERSION_1.version
  )
    return false;

  try {
    const frozenHash = RESEARCH_VERSION_1.releaseMetadata?.manifestHash;
    return (
      !!frozenHash &&
      validateBuiltinWorkflowRelease(detail.version) === frozenHash &&
      detail.version.releaseMetadata?.manifestHash === frozenHash
    );
  } catch {
    return false;
  }
}

function hasCompletedProducerCheckpoint(
  detail: WorkflowDetail,
  producer: WorkflowStepRun,
  binding: WorkflowArtifactBinding,
): boolean {
  const expectedBindingHash = bindingHash(binding);
  return detail.checkpoints.some(
    (checkpoint) =>
      checkpoint.workflowRunId === detail.run.id &&
      checkpoint.definitionVersion === detail.run.definitionVersion &&
      Number.isSafeInteger(checkpoint.sequence) &&
      checkpoint.sequence > 0 &&
      SHA256_PATTERN.test(checkpoint.stateHash) &&
      checkpoint.completedStepRunIds.includes(producer.id) &&
      !checkpoint.activeStepRunIds.includes(producer.id) &&
      checkpoint.artifactBindingHashes.includes(expectedBindingHash),
  );
}

function validBoundArtifact(
  detail: WorkflowDetail,
  output: DeliveryOutput,
  producer: WorkflowStepRun,
  options: ResearchDeliveryProjectionOptions,
): ValidBoundArtifact | null {
  if (
    producer.workflowRunId !== detail.run.id ||
    producer.stepId !== output.stepId ||
    producer.state !== 'COMPLETED' ||
    !Number.isSafeInteger(producer.attempt) ||
    producer.attempt < 1 ||
    !producer.missionId ||
    !producer.missionRunId
  )
    return null;

  const frozenStep = RESEARCH_VERSION_1.steps.find((step) => step.id === output.stepId);
  const spec = frozenStep?.outputs.find((candidate) => candidate.key === output.key);
  const contract = RESEARCH_VERSION_1.contractManifest?.find(
    (candidate) =>
      candidate.contractId === spec?.contractId &&
      candidate.contractVersion === spec?.contractVersion,
  );
  if (!spec || !contract) return null;

  const bindings = detail.bindings.filter(
    (candidate) =>
      candidate.workflowRunId === detail.run.id &&
      candidate.stepRunId === producer.id &&
      candidate.role === 'OUTPUT' &&
      candidate.key === output.key,
  );
  if (bindings.length !== 1) return null;
  const binding = bindings[0]!;
  if (binding.contractId !== spec.contractId || binding.contractVersion !== spec.contractVersion)
    return null;

  const artifacts = detail.artifacts.filter((candidate) => candidate.id === binding.artifactId);
  if (artifacts.length !== 1) return null;
  const artifact = artifacts[0]!;
  if (
    artifact.workflowRunId !== detail.run.id ||
    artifact.producerStepRunId !== producer.id ||
    artifact.missionId !== producer.missionId ||
    artifact.missionRunId !== producer.missionRunId ||
    artifact.kind !== spec.kind ||
    typeof artifact.content !== 'string' ||
    typeof artifact.actorId !== 'string' ||
    !artifact.actorId.trim() ||
    typeof artifact.sourceId !== 'string' ||
    !artifact.sourceId.trim() ||
    !['MISSION', 'HUMAN_BRIDGE'].includes(artifact.source) ||
    !isRecord(artifact.metadata) ||
    !SHA256_PATTERN.test(artifact.contentHash) ||
    artifact.contentHash !== artifactEnvelopeHash(artifact)
  )
    return null;

  const receipts = detail.validations.filter(
    (candidate) => candidate.artifactId === artifact.id && candidate.stepRunId === producer.id,
  );
  if (
    receipts.length !== 1 ||
    receipts[0]!.contractId !== contract.contractId ||
    receipts[0]!.contractVersion !== contract.contractVersion ||
    receipts[0]!.validatorVersion !== contract.validatorVersion ||
    receipts[0]!.contentHash !== artifact.contentHash ||
    receipts[0]!.valid !== true ||
    receipts[0]!.errors.length !== 0 ||
    !hasCompletedProducerCheckpoint(detail, producer, binding)
  )
    return null;

  if (options.verifyMissionFact) {
    try {
      if (!options.verifyMissionFact(artifact, producer)) return null;
    } catch {
      return null;
    }
  }

  return { artifact, producer };
}

function parsedOutcome(
  item: ValidBoundArtifact,
  output: DeliveryOutput,
): ResearchDeliveryOutcome | null | undefined {
  if (output.key !== 'research.experiment_record' && output.key !== 'research.review')
    return undefined;

  let value: unknown;
  try {
    value = JSON.parse(item.artifact.content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  if (output.key === 'research.experiment_record') {
    const status = value.status;
    if (
      value.attemptNumber !== item.producer.attempt ||
      !['COMPLETED', 'FAILED', 'UNKNOWN'].includes(String(status))
    )
      return null;
    return status as ResearchDeliveryOutcome;
  }

  const verdict = value.verdict;
  if (!['PASS', 'REVISE', 'FAIL'].includes(String(verdict))) return null;
  return verdict as ResearchDeliveryOutcome;
}

function latestCompletedStep(detail: WorkflowDetail, stepId: string): WorkflowStepRun | null {
  const completed = detail.steps.filter(
    (step) =>
      step.workflowRunId === detail.run.id && step.stepId === stepId && step.state === 'COMPLETED',
  );
  if (!completed.length) return null;
  const latestAttempt = Math.max(...completed.map((step) => step.attempt));
  const latest = completed.filter((step) => step.attempt === latestAttempt);
  return latest.length === 1 ? latest[0]! : null;
}

function itemFor(bound: ValidBoundArtifact, output: DeliveryOutput): ResearchDeliveryItem | null {
  const outcome = parsedOutcome(bound, output);
  if (outcome === null) return null;
  return {
    artifactId: bound.artifact.id,
    key: output.key,
    displayName:
      output.category === 'experiment_record'
        ? `${output.displayName}（第 ${bound.producer.attempt} 次尝试）`
        : output.category === 'scientific_review'
          ? `${output.displayName}（第 ${bound.producer.attempt} 次审查）`
          : output.displayName,
    attempt: bound.producer.attempt,
    category: output.category,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/**
 * Projects displayable official Research artifacts from the durable W1 ledger. Every item resolves
 * to one same-run output artifact with a frozen contract receipt and a completed producer checkpoint.
 */
export function projectResearchDelivery(
  detail: WorkflowDetail,
  options: ResearchDeliveryProjectionOptions = {},
): ResearchDeliveryProjection {
  if (
    !detail ||
    !detail.run ||
    !detail.version ||
    !Array.isArray(detail.steps) ||
    !Array.isArray(detail.artifacts) ||
    !Array.isArray(detail.bindings) ||
    !Array.isArray(detail.validations) ||
    !Array.isArray(detail.checkpoints) ||
    !hasFrozenOfficialResearchVersion(detail)
  )
    return emptyProjection();

  const ordered: Array<{ item: ResearchDeliveryItem; order: number }> = [];
  const addEligible = (output: DeliveryOutput, producer?: WorkflowStepRun): void => {
    const candidates = producer
      ? [producer]
      : detail.steps
          .filter((step) => step.workflowRunId === detail.run.id && step.stepId === output.stepId)
          .sort((left, right) => left.attempt - right.attempt);
    for (const candidate of candidates) {
      const bound = validBoundArtifact(detail, output, candidate, options);
      if (!bound) continue;
      const item = itemFor(bound, output);
      if (item) ordered.push({ item, order: ordered.length });
    }
  };

  for (const output of DELIVERY_OUTPUTS) {
    if (output.key === 'research.final_package') continue;
    if (output.category === 'experiment_record' || output.category === 'scientific_review')
      addEligible(output);
    else {
      const producer = latestCompletedStep(detail, output.stepId);
      if (producer) addEligible(output, producer);
    }
  }

  const r13 = latestCompletedStep(detail, 'R13');
  const r11 = latestCompletedStep(detail, 'R11');
  const manuscriptOutput: DeliveryOutput | null = r13
    ? {
        stepId: 'R13',
        key: 'research.revised_manuscript',
        category: 'manuscript',
        displayName: '最终论文稿（修订版）',
      }
    : r11
      ? {
          stepId: 'R11',
          key: 'research.manuscript',
          category: 'manuscript',
          displayName: '最终论文稿',
        }
      : null;
  const latestManuscriptStep = r13 ?? r11;
  if (manuscriptOutput && latestManuscriptStep) addEligible(manuscriptOutput, latestManuscriptStep);

  const finalPackageStep = latestCompletedStep(detail, 'R14');
  const finalPackageOutput = DELIVERY_OUTPUTS.find(
    (output) => output.key === 'research.final_package',
  );
  if (finalPackageStep && finalPackageOutput) addEligible(finalPackageOutput, finalPackageStep);

  return {
    items: ordered.sort((left, right) => left.order - right.order).map(({ item }) => item),
  };
}
