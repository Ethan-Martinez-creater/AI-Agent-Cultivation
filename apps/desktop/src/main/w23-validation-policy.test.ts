import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  WorkflowArtifact,
  WorkflowArtifactSpec,
  WorkflowDetail,
  WorkflowStepRun,
  WorkflowVersion,
} from '@cultivation/domain';
import {
  researchReviewIndependence,
  researchWorkflowValidationPolicy,
  type ResearchExperimentFact,
  type ResearchIntegrityFacts,
  type ResearchSourceArtifactFact,
} from './w23-validation-policy.js';

const runId = 'research-run';
const missionId = 'mission';
const missionRunId = 'mission-run';
let sequence = 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function makeStep(
  stepId: string,
  state: WorkflowStepRun['state'] = 'COMPLETED',
  attempt = 1,
): WorkflowStepRun {
  sequence += 1;
  return {
    id: stepId.toLowerCase() + '-' + attempt,
    workflowRunId: runId,
    stepId,
    attempt,
    state,
    missionId,
    missionRunId,
    waitReason: null,
    errorCode: null,
    createdAt: '2026-10-04T00:00:' + String(sequence).padStart(2, '0') + '.000Z',
    updatedAt: '2026-10-04T00:01:00.000Z',
  };
}

function makeDetail(
  steps: WorkflowStepRun[],
  mode: 'COMPUTATIONAL' | 'HUMAN_OR_EXTERNAL' | 'MIXED' = 'COMPUTATIONAL',
): WorkflowDetail {
  const version = {
    definition: { id: 'official.research', source: 'BUILTIN' },
    version: 1,
    validationPolicy: 'research-integrity-v1',
    steps: steps.map((item) => ({ id: item.stepId })),
  } as unknown as WorkflowVersion;
  return {
    run: {
      id: runId,
      definitionId: 'official.research',
      definitionVersion: 1,
      inputSnapshot: {
        researchQuestion: 'Question?',
        field: 'Systems',
        experimentMode: mode,
        maxExperimentCycles: 2,
      },
      state: 'RUNNING',
      waitReason: null,
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:01:00.000Z',
    },
    version,
    steps,
    artifacts: [],
    bindings: [],
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
    operations: [],
    traversals: [],
  } as unknown as WorkflowDetail;
}

function addOutput(
  detail: WorkflowDetail,
  producer: WorkflowStepRun,
  key: string,
  value: unknown,
  options: Partial<
    Pick<WorkflowArtifact, 'kind' | 'source' | 'actorId' | 'sourceId' | 'metadata'>
  > = {},
): WorkflowArtifact {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  const artifact: WorkflowArtifact = {
    id: 'artifact-' + String(sequence++).padStart(3, '0'),
    workflowRunId: runId,
    producerStepRunId: producer.id,
    missionId: producer.missionId ?? missionId,
    missionRunId: producer.missionRunId ?? missionRunId,
    actorId: options.actorId ?? 'teammate-a',
    sourceId: options.sourceId ?? 'event-' + sequence,
    source: options.source ?? 'MISSION',
    kind: options.kind ?? 'JSON',
    content,
    contentHash: hash(content),
    metadata: options.metadata ?? {},
    inputArtifactIds: [],
    createdAt: producer.createdAt,
  };
  detail.artifacts.push(artifact);
  detail.bindings.push({
    id: 'binding-' + artifact.id,
    workflowRunId: runId,
    stepRunId: producer.id,
    key,
    artifactId: artifact.id,
    role: 'OUTPUT',
    contractId: key,
    contractVersion: '1',
    createdAt: artifact.createdAt,
  });
  return artifact;
}

const produced = (key: string, artifact: WorkflowArtifact) => ({
  spec: { key } as WorkflowArtifactSpec,
  artifact,
});

function makeSourceFact(stepRunId = 'r02-1'): ResearchSourceArtifactFact {
  const contentHash = hash('actual source contents');
  return {
    workflowRunId: runId,
    stepRunId,
    sourceArtifactId: 'source-' + contentHash,
    missionId,
    missionRunId,
    evidenceEventId: 'durable-tool-event',
    actorId: 'teammate-a',
    toolCallId: 'tool-call-1',
    toolId: 'mcp.research',
    url: 'https://source.example/paper',
    contentHash,
    outputHash: hash('tool output'),
    kind: 'RESEARCH_TOOL',
    attempt: 1,
  };
}

function makeFacts(
  options: {
    sources?: ResearchSourceArtifactFact[];
    experiments?: ResearchExperimentFact[];
    resolve?: (run: string, id: string) => ResearchSourceArtifactFact | undefined;
    accepted?: (stepRunId: string) => Array<Record<string, unknown>>;
  } = {},
): ResearchIntegrityFacts {
  return {
    listSourceArtifactsForRun: () => options.sources ?? [],
    listExperimentFactsForStep: () => options.experiments ?? [],
    resolveSourceArtifact: options.resolve,
    listAcceptedExperimentArtifactsForStep: (stepRunId) =>
      (options.accepted?.(stepRunId) ?? []) as never,
  };
}

function makeComputationalAttempt() {
  const r07 = makeStep('R07');
  const r08 = makeStep('R08', 'RUNNING');
  const detail = makeDetail([r07, r08]);
  const plan = addOutput(detail, r07, 'research.experiment_plan', {
    method: 'deterministic benchmark',
  });
  detail.bindings.push({
    id: 'input-plan',
    workflowRunId: runId,
    stepRunId: r08.id,
    key: 'experiment_plan',
    artifactId: plan.id,
    role: 'INPUT',
    contractId: 'research.experiment-plan',
    contractVersion: '1',
    createdAt: r08.createdAt,
  } as never);
  const rawPath = `workflows/${runId}/${r08.id}/research/raw-result.json`;
  const logPath = `workflows/${runId}/${r08.id}/research/experiment-log.txt`;
  const rawHash = hash('raw result bytes');
  const logHash = hash('experiment log bytes');
  const record = {
    attemptNumber: 1,
    mode: 'COMPUTATIONAL',
    planArtifactId: plan.id,
    operationKey: 'research-operation-1',
    status: 'COMPLETED',
    rawResult: { relativePath: rawPath, contentHash: rawHash },
    experimentLog: { relativePath: logPath, contentHash: logHash },
    metrics: [],
    negativeResults: [],
    failureDetails: [],
    limitations: [],
    reproducibilityNotes: ['fixed seed'],
  };
  const recordArtifact = addOutput(detail, r08, 'research.experiment_record', record);
  const rawArtifact = addOutput(detail, r08, 'research.raw_result', '', {
    kind: 'FILE',
    metadata: { path: rawPath, contentHash: rawHash },
  });
  const logArtifact = addOutput(detail, r08, 'research.experiment_log', '', {
    kind: 'FILE',
    metadata: { path: logPath, contentHash: logHash },
  });
  const producedRows = [
    produced('research.experiment_record', recordArtifact),
    produced('research.raw_result', rawArtifact),
    produced('research.experiment_log', logArtifact),
  ];
  detail.operations = [
    {
      id: 'operation-1',
      workflowRunId: runId,
      stepRunId: r08.id,
      attempt: 1,
      operationKey: 'research-operation-1',
      effectType: 'FILE_OUTPUT',
      state: 'APPLIED',
      inputHash: hash('operation input'),
      manifest: [
        { relativePath: rawPath, afterHash: rawHash },
        { relativePath: logPath, afterHash: logHash },
      ],
    },
  ] as never;
  const experiment: ResearchExperimentFact = {
    workflowRunId: runId,
    stepRunId: r08.id,
    attempt: 1,
    missionId,
    missionRunId,
    actorId: recordArtifact.actorId,
    toolCallId: 'tool-call-experiment',
    toolId: 'mcp.experiment',
    outputHash: hash('tool output'),
    planArtifactId: plan.id,
    status: 'SUCCEEDED',
    method: 'deterministic benchmark',
    negativeResult: false,
    rawResults: [],
    logArtifactIds: [],
    files: [
      {
        sourceArtifactId: `source-${rawHash}`,
        relativePath: rawPath,
        contentHash: rawHash,
        key: 'research.raw_result',
      },
      {
        sourceArtifactId: `source-${logHash}`,
        relativePath: logPath,
        contentHash: logHash,
        key: 'research.experiment_log',
      },
    ],
  };
  return { detail, r08, producedRows, experiment, rawArtifact, logArtifact };
}

function literatureFor(source: ResearchSourceArtifactFact) {
  return {
    sources: [
      {
        sourceId: 'src-1',
        title: 'Real paper',
        authors: ['A. Author'],
        year: 2024,
        source: 'Example Journal',
        url: source.url,
        doi: '',
        identifier: 'id-1',
        discoveryMethod: 'RESEARCH_TOOL',
        sourceArtifactId: source.sourceArtifactId,
        discoveryToolId: source.toolId,
        sourceContentHash: source.contentHash,
      },
    ],
    searchMethods: [
      {
        methodId: 'search-1',
        description: 'Search by title',
        discoveryToolId: source.toolId,
        sourceArtifactIds: [source.sourceArtifactId],
      },
    ],
    searchLimitations: ['The search was bounded.'],
  };
}

describe('research-integrity-v1', () => {
  it('rejects fabricated citations and accepts a source tied to a real same-run Tool event', () => {
    const r02 = makeStep('R02', 'RUNNING');
    const detail = makeDetail([r02]);
    const source = makeSourceFact(r02.id);
    const literature = addOutput(detail, r02, 'research.literature', literatureFor(source));
    const call = [produced('research.literature', literature)];
    expect(researchWorkflowValidationPolicy(makeFacts()).validateStep(detail, r02, call)).toContain(
      'RESEARCH_CITATION_PROVENANCE_INVALID',
    );
    expect(
      researchWorkflowValidationPolicy(makeFacts({ sources: [source] })).validateStep(
        detail,
        r02,
        call,
      ),
    ).toEqual([]);
    const foreign = { ...source, missionRunId: 'another-run' };
    expect(
      researchWorkflowValidationPolicy(makeFacts({ sources: [foreign] })).validateStep(
        detail,
        r02,
        call,
      ),
    ).toContain('RESEARCH_CITATION_PROVENANCE_INVALID');
  });

  it('rejects a user source citation whose URL is absent from the accepted packet', () => {
    const r02 = makeStep('R02', 'RUNNING');
    const detail = makeDetail([r02]);
    const packetHash = hash('accepted packet');
    const packet = addOutput(
      detail,
      r02,
      'research.source_packet',
      {
        sources: [
          {
            title: 'Provided report',
            authors: ['Human Author'],
            year: 2025,
            source: 'User document',
            url: 'https://actual.example/report',
            doi: '',
            identifier: 'report-1',
            excerpt: 'actual text',
          },
        ],
      },
      {
        source: 'HUMAN_BRIDGE',
        actorId: 'human-bridge',
        metadata: {
          targetArtifactId: 'research.source_packet',
          acceptedSourceReport: 1,
          sourceReportId: 'accepted-file-1',
          sourceReportHash: packetHash,
        },
      },
    );
    const citation = {
      sourceId: 'src-user',
      title: 'Provided report',
      authors: ['Human Author'],
      year: 2025,
      source: 'User document',
      url: 'https://forged.example/report',
      doi: '',
      identifier: 'report-1',
      discoveryMethod: 'USER_SOURCE_ARTIFACT',
      sourceArtifactId: 'source-' + packetHash,
      sourceContentHash: packetHash,
      discoveryToolId: '',
    };
    const literature = addOutput(detail, r02, 'research.literature', {
      sources: [citation],
      searchMethods: [],
      searchLimitations: [],
    });
    const fakeFacts = makeFacts({
      accepted: (stepRunId) =>
        stepRunId === r02.id
          ? [
              {
                workflowRunId: runId,
                stepRunId,
                missionId,
                missionRunId,
                requestId: 'request-1',
                actorId: 'human-bridge',
                artifactId: 'accepted-file-1',
                relativePath: 'source.json',
                contentHash: packetHash,
                targetArtifactId: 'research.source_packet',
                state: 'ACCEPTED',
                sourceArtifactId: 'source-' + packetHash,
              },
            ]
          : [],
    });
    expect(
      researchWorkflowValidationPolicy(fakeFacts).validateStep(detail, r02, [
        produced('research.literature', literature),
        produced('research.source_packet', packet),
      ]),
    ).toContain('RESEARCH_CITATION_PROVENANCE_INVALID');
  });

  it('requires every screened source to have a reason and keeps evidence on its included source', () => {
    const r02 = makeStep('R02');
    const r03 = makeStep('R03', 'RUNNING');
    const detail = makeDetail([r02, r03]);
    const source = makeSourceFact(r02.id);
    addOutput(detail, r02, 'research.literature', literatureFor(source));
    const screening = addOutput(detail, r03, 'research.screening', {
      sources: [
        {
          sourceId: 'src-1',
          sourceArtifactId: source.sourceArtifactId,
          decision: 'EXCLUDED',
          reason: '',
          criteria: [],
        },
      ],
      screeningNotes: [],
    });
    const evidence = addOutput(detail, r03, 'research.evidence', { claims: [] });
    expect(
      researchWorkflowValidationPolicy(makeFacts({ sources: [source] })).validateStep(detail, r03, [
        produced('research.screening', screening),
        produced('research.evidence', evidence),
      ]),
    ).toContain('RESEARCH_SCREENING_REASON_OR_PROVENANCE_REQUIRED');
  });

  it('derives review independence from actual artifact actors and rejects a model-authored flag', () => {
    const r05 = makeStep('R05');
    const r06 = makeStep('R06', 'RUNNING');
    const detail = makeDetail([r05, r06]);
    const hypotheses = addOutput(
      detail,
      r05,
      'research.hypotheses',
      { hypotheses: [] },
      { actorId: 'author-a' },
    );
    const sameActor = addOutput(
      detail,
      r06,
      'research.review',
      {
        verdict: 'PASS',
        findings: [],
        evidence: [],
        summary: 'Reviewed',
        reviewedArtifactIds: [hypotheses.id],
      },
      { actorId: 'author-a' },
    );
    expect(researchReviewIndependence(detail, r06)).toBe(false);
    expect(sameActor.id).toBeTruthy();
    const forged = addOutput(detail, r06, 'research.review', {
      verdict: 'PASS',
      findings: [],
      evidence: [],
      summary: 'Reviewed',
      reviewedArtifactIds: [hypotheses.id],
      reviewIndependence: true,
    });
    expect(
      researchWorkflowValidationPolicy(makeFacts()).validateStep(detail, r06, [
        produced('research.review', forged),
      ]),
    ).toContain('RESEARCH_REVIEW_EVIDENCE_INVALID');
  });

  it('rejects legacy claimType and artifact IDs outside the current Run', () => {
    const r11 = makeStep('R11', 'RUNNING');
    const detail = makeDetail([r11]);
    const evidence = addOutput(detail, r11, 'research.evidence', { claims: [] });
    const forged = addOutput(detail, r11, 'research.claim_evidence_map', {
      claims: [
        {
          claimId: 'claim-1',
          claim: 'A result',
          claimType: 'EVIDENCE',
          artifactIds: ['foreign'],
          note: '',
        },
      ],
    });
    expect(
      researchWorkflowValidationPolicy(makeFacts()).validateStep(detail, r11, [
        produced('research.claim_evidence_map', forged),
      ]),
    ).toContain('RESEARCH_CLAIM_EVIDENCE_TRACE_INVALID');
    const valid = addOutput(detail, r11, 'research.claim_evidence_map', {
      claims: [
        {
          claimId: 'claim-2',
          claim: 'A result',
          classification: 'EVIDENCE',
          artifactIds: [evidence.id],
          note: '',
        },
      ],
    });
    expect(
      researchWorkflowValidationPolicy(makeFacts()).validateStep(detail, r11, [
        produced('research.claim_evidence_map', valid),
      ]),
    ).toEqual([]);
  });

  it('requires same-step durable Tool evidence and accepts APPLIED manifest before output IDs are committed', () => {
    const { detail, r08, producedRows, experiment, rawArtifact, logArtifact } =
      makeComputationalAttempt();
    expect(
      researchWorkflowValidationPolicy(makeFacts()).validateStep(detail, r08, producedRows),
    ).toContain('RESEARCH_EXPERIMENT_TOOL_FACT_REQUIRED');
    const policy = researchWorkflowValidationPolicy(makeFacts({ experiments: [experiment] }));
    expect(policy.validateStep(detail, r08, producedRows)).toEqual([]);

    const operation = detail.operations![0]!;
    detail.operations = [
      { ...operation, state: 'VERIFIED', outputArtifactIds: [rawArtifact.id, logArtifact.id] },
    ] as never;
    expect(policy.validateStep(detail, r08, producedRows)).toEqual([]);
    detail.operations = [
      { ...operation, state: 'VERIFIED', outputArtifactIds: [rawArtifact.id] },
    ] as never;
    expect(policy.validateStep(detail, r08, producedRows)).toContain(
      'RESEARCH_OPERATION_OUTPUT_BINDING_INVALID',
    );
  });

  it('binds pure Human Bridge experiment receipts to the accepted artifact ID under the existing W1 contract', () => {
    const r07 = makeStep('R07');
    const r08 = makeStep('R08', 'RUNNING');
    const detail = makeDetail([r07, r08], 'HUMAN_OR_EXTERNAL');
    const plan = addOutput(detail, r07, 'research.experiment_plan', {
      method: 'field observation',
    });
    detail.bindings.push({
      id: 'input-plan',
      workflowRunId: runId,
      stepRunId: r08.id,
      key: 'experiment_plan',
      artifactId: plan.id,
      role: 'INPUT',
      contractId: 'research.experiment-plan',
      contractVersion: '1',
      createdAt: r08.createdAt,
    } as never);
    const rawPath = `workflows/${runId}/${r08.id}/research/raw-result.json`;
    const logPath = `workflows/${runId}/${r08.id}/research/experiment-log.txt`;
    const rawHash = hash('human raw bytes');
    const logHash = hash('human log bytes');
    const recordHash = hash('human record bytes');
    const record = {
      attemptNumber: 1,
      mode: 'HUMAN_OR_EXTERNAL',
      planArtifactId: plan.id,
      operationKey: 'human-operation-1',
      status: 'COMPLETED',
      rawResult: { relativePath: rawPath, contentHash: rawHash },
      experimentLog: { relativePath: logPath, contentHash: logHash },
      metrics: [],
      negativeResults: [],
      failureDetails: [],
      limitations: [],
      reproducibilityNotes: ['observed directly'],
    };
    const recordArtifact = addOutput(detail, r08, 'research.experiment_record', record, {
      source: 'HUMAN_BRIDGE',
      actorId: 'bridge-actor',
      sourceId: 'accepted-record-artifact',
      metadata: { targetArtifactId: 'research.experiment_record', contentHash: recordHash },
    });
    const rawArtifact = addOutput(detail, r08, 'research.raw_result', '', {
      kind: 'FILE',
      source: 'HUMAN_BRIDGE',
      actorId: 'bridge-actor',
      sourceId: 'accepted-raw-artifact',
      metadata: { path: rawPath, contentHash: rawHash },
    });
    const logArtifact = addOutput(detail, r08, 'research.experiment_log', '', {
      kind: 'FILE',
      source: 'HUMAN_BRIDGE',
      actorId: 'bridge-actor',
      sourceId: 'accepted-log-artifact',
      metadata: { path: logPath, contentHash: logHash },
    });
    const operation = {
      id: 'external-operation',
      workflowRunId: runId,
      stepRunId: r08.id,
      attempt: 1,
      operationKey: 'human-operation-1',
      effectType: 'EXTERNAL_ACTION',
      state: 'APPLIED',
      inputHash: hash('external input'),
      externalReference: 'accepted-record-artifact',
    };
    detail.operations = [operation] as never;
    const accepted = [
      {
        artifactId: 'accepted-record-artifact',
        targetArtifactId: 'research.experiment_record',
        relativePath: `workflows/${runId}/${r08.id}/output/research.experiment_record.json`,
        contentHash: recordHash,
      },
      {
        artifactId: 'accepted-raw-artifact',
        targetArtifactId: 'research.raw_result',
        relativePath: rawPath,
        contentHash: rawHash,
      },
      {
        artifactId: 'accepted-log-artifact',
        targetArtifactId: 'research.experiment_log',
        relativePath: logPath,
        contentHash: logHash,
      },
    ].map((row) => ({
      workflowRunId: runId,
      stepRunId: r08.id,
      missionId,
      missionRunId,
      requestId: 'accepted-request',
      actorId: 'bridge-actor',
      state: 'ACCEPTED' as const,
      ...row,
    }));
    expect(
      researchWorkflowValidationPolicy(makeFacts({ accepted: () => accepted })).validateStep(
        detail,
        r08,
        [
          produced('research.experiment_record', recordArtifact),
          produced('research.raw_result', rawArtifact),
          produced('research.experiment_log', logArtifact),
        ],
      ),
    ).toEqual([]);
  });

  it('blocks cycle limits above the frozen maximum and an R10 step without validated analysis', () => {
    const detail = makeDetail([]);
    const policy = researchWorkflowValidationPolicy(makeFacts());
    expect(() =>
      policy.validateInputs(detail.version, {
        researchQuestion: 'Question?',
        field: 'Systems',
        experimentMode: 'COMPUTATIONAL',
        maxExperimentCycles: 3,
      }),
    ).toThrow();
    const r10 = makeStep('R10', 'RUNNING');
    r10.missionId = null;
    r10.missionRunId = null;
    const empty = makeDetail([r10]);
    expect(policy.decisionBranch?.(empty, r10)).toEqual({ branch: 'BLOCKED', waitForUser: true });
  });
});
