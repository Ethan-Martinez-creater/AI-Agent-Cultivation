import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ResearchDeliveryItem,
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowStepRun,
} from '@cultivation/domain';
import { RESEARCH_DEFINITION_ID, RESEARCH_VERSION_1 } from './builtin/research/v1.js';
import { projectResearchDelivery } from './research-delivery-projection.js';

const foreignReferenceCases: Array<[string, (artifact: WorkflowArtifact) => void]> = [
  [
    'foreign workflow run',
    (artifact) => {
      artifact.workflowRunId = 'foreign-run';
    },
  ],
  [
    'foreign producer step',
    (artifact) => {
      artifact.producerStepRunId = 'foreign-step';
    },
  ],
  [
    'foreign mission run',
    (artifact) => {
      artifact.missionRunId = 'foreign-mission-run';
    },
  ],
];

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

function workflowHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function createDetail(): WorkflowDetail {
  return {
    run: {
      id: 'research-run-1',
      definitionId: RESEARCH_DEFINITION_ID,
      definitionVersion: 1,
      state: 'COMPLETED',
      waitReason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    version: RESEARCH_VERSION_1,
    steps: [],
    artifacts: [],
    bindings: [],
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
  };
}

function addStep(
  detail: WorkflowDetail,
  stepId: string,
  attempt: number,
  state: WorkflowStepRun['state'] = 'COMPLETED',
): WorkflowStepRun {
  const stepRun: WorkflowStepRun = {
    id: `${stepId.toLowerCase()}-run-${attempt}`,
    workflowRunId: detail.run.id,
    stepId,
    attempt,
    state,
    missionId: `mission-${stepId.toLowerCase()}-${attempt}`,
    missionRunId: `mission-run-${stepId.toLowerCase()}-${attempt}`,
    waitReason: null,
    errorCode: state === 'FAILED' ? 'TEST_FAILURE' : null,
    createdAt: `2026-01-${String(attempt).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: `2026-01-${String(attempt).padStart(2, '0')}T00:01:00.000Z`,
  };
  detail.steps.push(stepRun);
  return stepRun;
}

function addOutput(
  detail: WorkflowDetail,
  stepId: string,
  attempt: number,
  key: string,
  content: string,
  createdAt = '2026-01-03T00:00:00.000Z',
): WorkflowArtifact {
  const producer =
    detail.steps.find((step) => step.stepId === stepId && step.attempt === attempt) ??
    addStep(detail, stepId, attempt);
  const spec = RESEARCH_VERSION_1.steps
    .find((step) => step.id === stepId)!
    .outputs.find((output) => output.key === key)!;
  const contract = RESEARCH_VERSION_1.contractManifest!.find(
    (candidate) =>
      candidate.contractId === spec.contractId &&
      candidate.contractVersion === spec.contractVersion,
  )!;
  const artifact: WorkflowArtifact = {
    id: `artifact-${key}-${attempt}`,
    workflowRunId: detail.run.id,
    producerStepRunId: producer.id,
    missionId: producer.missionId!,
    missionRunId: producer.missionRunId!,
    actorId: `actor-${stepId}-${attempt}`,
    sourceId: `source-${stepId}-${attempt}`,
    source: 'MISSION',
    kind: spec.kind,
    content,
    contentHash: '',
    metadata: { outputKey: key },
    inputArtifactIds: [],
    createdAt,
  };
  artifact.contentHash = workflowHash({ content: artifact.content, metadata: artifact.metadata });

  detail.artifacts.push(artifact);
  detail.bindings.push({
    id: `binding-${key}-${attempt}`,
    workflowRunId: detail.run.id,
    stepRunId: producer.id,
    key,
    artifactId: artifact.id,
    role: 'OUTPUT',
    contractId: spec.contractId,
    contractVersion: spec.contractVersion,
    createdAt,
  });
  detail.validations.push({
    id: `validation-${key}-${attempt}`,
    stepRunId: producer.id,
    artifactId: artifact.id,
    contractId: spec.contractId,
    contractVersion: spec.contractVersion,
    validatorVersion: contract.validatorVersion,
    contentHash: artifact.contentHash,
    valid: true,
    errors: [],
    createdAt,
  });
  return artifact;
}

function finishCheckpoints(detail: WorkflowDetail): void {
  for (const producer of detail.steps.filter((step) => step.state === 'COMPLETED')) {
    const bindingHashes = detail.bindings
      .filter((binding) => binding.stepRunId === producer.id)
      .map((binding) => workflowHash(binding));
    detail.checkpoints.push({
      id: `checkpoint-${producer.id}`,
      workflowRunId: detail.run.id,
      sequence: detail.checkpoints.length + 1,
      definitionVersion: detail.run.definitionVersion,
      completedStepRunIds: [producer.id],
      activeStepRunIds: [],
      artifactBindingHashes: bindingHashes,
      decisionHashes: [],
      stateHash: 'a'.repeat(64),
      createdAt: producer.updatedAt,
    });
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function addCompleteDeliveryFixture(detail: WorkflowDetail): {
  olderRevision: WorkflowArtifact;
  latestRevision: WorkflowArtifact;
  recordArtifacts: WorkflowArtifact[];
  actualManuscript: WorkflowArtifact;
} {
  addOutput(
    detail,
    'R01',
    1,
    'research.brief',
    json({
      researchQuestion: 'question',
      field: 'field',
      scope: '',
      definitions: [],
      constraints: [],
      successCriteria: ['success'],
      knownAssumptions: [],
    }),
  );
  addOutput(detail, 'R03', 1, 'research.evidence', json({ claims: [] }));
  addOutput(
    detail,
    'R04',
    1,
    'research.landscape',
    '已有证据\n本 Run 已整理的证据概览。\n推断\n根据证据形成的推断。\n未知\n仍需验证的事项。',
  );
  addOutput(detail, 'R05', 1, 'research.hypotheses', json({ hypotheses: [] }));
  addOutput(
    detail,
    'R07',
    1,
    'research.experiment_plan',
    json({
      hypothesisId: 'hypothesis-1',
      method: 'planned method',
      variables: [],
      datasetOrSamples: 'sample data',
      controls: [],
      baselines: [],
      metrics: [],
      procedure: [],
      expectedArtifacts: [],
      failureConditions: [],
      resourceRequirements: [],
      reproducibilityNotes: [],
      externalExecutionRequirements: [],
    }),
  );

  const record = (attemptNumber: number, status: 'COMPLETED' | 'FAILED', negative: string[]) =>
    json({
      attemptNumber,
      mode: 'COMPUTATIONAL',
      planArtifactId: 'untrusted-plan-id',
      operationKey: `operation-${attemptNumber}`,
      status,
      rawResult: { relativePath: 'research/raw-result.json', contentHash: 'b'.repeat(64) },
      experimentLog: { relativePath: 'research/experiment-log.txt', contentHash: 'c'.repeat(64) },
      metrics: [],
      negativeResults: negative,
      failureDetails: status === 'FAILED' ? ['The experiment failed.'] : [],
      limitations: [],
      reproducibilityNotes: [],
    });
  const recordArtifacts = [
    addOutput(
      detail,
      'R08',
      1,
      'research.experiment_record',
      record(1, 'FAILED', ['Metric decreased.']),
    ),
    addOutput(detail, 'R08', 2, 'research.experiment_record', record(2, 'COMPLETED', [])),
  ];
  // A real execution attempt without a valid artifact is represented by its Step state only.
  addStep(detail, 'R08', 3, 'FAILED');
  addOutput(
    detail,
    'R09',
    1,
    'research.analysis',
    '分析方法：描述本次分析流程。\n指标：列出本次评估指标。\n不确定性：说明结果中的不确定性。\n负面结果：保留未支持假设的结果。\n失败实验：记录失败运行及原因。\n局限：说明当前数据与执行的局限。',
  );
  addOutput(
    detail,
    'R09',
    1,
    'research.analysis_results',
    json({
      method: 'bounded analysis',
      metrics: [],
      uncertainty: [],
      negativeResults: [],
      failedRuns: [],
      dataComplete: true,
      executionValid: true,
      refinementTarget: 'NONE',
      decisionRationale: 'The recorded data was analyzed.',
      supportingArtifactIds: [],
    }),
  );
  addOutput(
    detail,
    'R11',
    1,
    'research.manuscript',
    'Abstract\nIntroduction\nMethods\nResults\nDiscussion\nLimitations',
  );

  const olderRevision = addOutput(
    detail,
    'R13',
    1,
    'research.revised_manuscript',
    'Abstract\nIntroduction\nMethods\nResults\nDiscussion\nLimitations\nolder revision',
    '2030-01-01T00:00:00.000Z',
  );
  const latestRevision = addOutput(
    detail,
    'R13',
    2,
    'research.revised_manuscript',
    'Abstract\nIntroduction\nMethods\nResults\nDiscussion\nLimitations\nlatest by attempt',
    '2020-01-01T00:00:00.000Z',
  );
  const actualManuscript = latestRevision;
  addOutput(
    detail,
    'R12',
    1,
    'research.review',
    json({
      verdict: 'REVISE',
      findings: ['revise'],
      evidence: [],
      summary: 'Revise',
      reviewedArtifactIds: [],
    }),
  );
  addOutput(
    detail,
    'R12',
    2,
    'research.review',
    json({
      verdict: 'PASS',
      findings: [],
      evidence: [],
      summary: 'Pass',
      reviewedArtifactIds: [],
    }),
  );
  addOutput(
    detail,
    'R14',
    1,
    'research.final_package',
    json({
      finalManuscriptArtifactId: 'foreign-or-obsolete-manuscript',
      evidenceTableArtifactId: 'unverified-evidence-id',
      claimEvidenceMapArtifactIds: [],
      experimentAttempts: [],
      rawResultArtifactIds: [],
      experimentLogArtifactIds: [],
      analysisArtifactIds: [],
      figureArtifactIds: [],
      reviewHistoryArtifactIds: [],
      sourceArtifactIds: [],
      screeningArtifactId: 'unverified-screening-id',
      hypothesisArtifactIds: [],
      experimentPlanArtifactIds: [],
      reproducibilitySummary: 'Summary',
      conclusionStatus: 'NOT_SCIENTIFICALLY_CONFIRMED',
      submissionStatus: 'NOT_SUBMITTED',
    }),
  );

  finishCheckpoints(detail);
  return { olderRevision, latestRevision, recordArtifacts, actualManuscript };
}

function itemsFor(detail: WorkflowDetail, category: ResearchDeliveryItem['category']) {
  return projectResearchDelivery(detail).items.filter((item) => item.category === category);
}

describe('trusted Research delivery projection', () => {
  it('includes validated hypothesis review history as well as scientific manuscript reviews', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const review = addOutput(
      detail,
      'R06',
      3,
      'research.review',
      json({
        verdict: 'REVISE',
        findings: ['明确假设'],
        evidence: [],
        summary: '需要完善假设',
        reviewedArtifactIds: [],
      }),
    );
    finishCheckpoints(detail);
    expect(itemsFor(detail, 'scientific_review').map((item) => item.artifactId)).toContain(
      review.id,
    );
  });
  it('shows the latest validated hypotheses and plan while retaining older artifacts in Advanced', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const latest = addOutput(detail, 'R05', 2, 'research.hypotheses', json({ hypotheses: [] }));
    finishCheckpoints(detail);
    expect(itemsFor(detail, 'hypotheses').map((item) => item.artifactId)).toEqual([latest.id]);
    expect(
      detail.artifacts.filter((artifact) => artifact.metadata.outputKey === 'research.hypotheses'),
    ).toHaveLength(2);
  });
  it('projects every validated experiment record and keeps failed and negative outcomes visible', () => {
    const detail = createDetail();
    const { recordArtifacts } = addCompleteDeliveryFixture(detail);
    const records = itemsFor(detail, 'experiment_record');

    expect(
      records.map(({ artifactId, attempt, outcome }) => [artifactId, attempt, outcome]),
    ).toEqual([
      [recordArtifacts[0]!.id, 1, 'FAILED'],
      [recordArtifacts[1]!.id, 2, 'COMPLETED'],
    ]);
    expect(detail.steps.find((step) => step.stepId === 'R08' && step.attempt === 3)?.state).toBe(
      'FAILED',
    );
    expect(
      itemsFor(detail, 'scientific_review').map(({ attempt, outcome }) => [attempt, outcome]),
    ).toEqual([
      [1, 'REVISE'],
      [2, 'PASS'],
    ]);
  });

  it('selects the highest completed R13 attempt instead of using dates or package-supplied IDs', () => {
    const detail = createDetail();
    const { olderRevision, latestRevision, actualManuscript } = addCompleteDeliveryFixture(detail);
    const manuscripts = itemsFor(detail, 'manuscript');

    expect(olderRevision.createdAt).toBe('2030-01-01T00:00:00.000Z');
    expect(latestRevision.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(manuscripts).toHaveLength(1);
    expect(manuscripts[0]).toMatchObject({ artifactId: actualManuscript.id, attempt: 2 });
    expect(itemsFor(detail, 'final_package')).toHaveLength(1);
  });

  it('does not fall back to R11 when the newest completed R13 attempt has no valid manuscript', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const newestR13 = detail.steps.find((step) => step.stepId === 'R13' && step.attempt === 2)!;
    detail.bindings = detail.bindings.filter((binding) => binding.stepRunId !== newestR13.id);

    expect(itemsFor(detail, 'manuscript')).toEqual([]);
  });

  it('filters an artifact without its valid frozen-contract receipt', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const evidence = detail.artifacts.find(
      (artifact) => artifact.id === 'artifact-research.evidence-1',
    )!;
    detail.validations.find((receipt) => receipt.artifactId === evidence.id)!.valid = false;

    expect(itemsFor(detail, 'evidence_table')).toEqual([]);
  });

  it('requires the output binding to appear in a completed producer checkpoint', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    detail.checkpoints = [];

    expect(projectResearchDelivery(detail).items).toEqual([]);
  });

  it('filters tampered content whose durable W1 envelope hash no longer matches', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const evidence = detail.artifacts.find(
      (artifact) => artifact.id === 'artifact-research.evidence-1',
    )!;
    evidence.content = json({ claims: [{ claim: 'tampered' }] });

    expect(itemsFor(detail, 'evidence_table')).toEqual([]);
  });

  it.each(foreignReferenceCases)('filters an artifact with a %s reference', (_name, corrupt) => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    const evidence = detail.artifacts.find(
      (artifact) => artifact.id === 'artifact-research.evidence-1',
    )!;
    corrupt(evidence);

    expect(itemsFor(detail, 'evidence_table')).toEqual([]);
  });

  it('filters a Mission artifact rejected by the optional independent MissionRun verifier', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);

    const projection = projectResearchDelivery(detail, { verifyMissionFact: () => false });
    expect(projection.items).toEqual([]);
  });

  it('rejects obsolete or altered Research versions', () => {
    const detail = createDetail();
    addCompleteDeliveryFixture(detail);
    detail.version = { ...RESEARCH_VERSION_1, version: 2 };

    expect(projectResearchDelivery(detail).items).toEqual([]);
  });
});
