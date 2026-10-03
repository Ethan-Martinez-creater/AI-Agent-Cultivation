import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateWorkflowVersion } from '@cultivation/domain';
import { workflowHash } from '../../w1-workflow-service.js';
import {
  AI_NEWS_VIDEO_ACCEPTANCE_INPUTS,
  AI_NEWS_VIDEO_CONTRACTS,
  AI_NEWS_VIDEO_PACKAGE,
  AI_NEWS_VIDEO_PHASES,
  AI_NEWS_VIDEO_REVISION_GROUPS,
  AI_NEWS_VIDEO_VERSION_1,
  validateNewsInputs,
  validateNewsStep,
  type NewsArtifactEvidence,
} from './v1.js';
import { createAiNewsAcceptanceOutput, type AiNewsFixtureMedia } from './test-data.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const syntheticVideoBytes = Buffer.from('test-only-mp4-fixture');

function testVideo(durationSeconds: number): AiNewsFixtureMedia {
  return {
    path: 'workflows/run-short/N12-attempt-1/output/draft.mp4',
    contentHash: hash(syntheticVideoBytes),
    sizeBytes: syntheticVideoBytes.byteLength,
    durationSeconds,
    width: 640,
    height: 360,
    videoCodec: 'h264',
    audioCodec: 'aac',
    hasAudio: true,
    extension: '.mp4',
    mediaType: 'video/mp4',
    bytes: syntheticVideoBytes,
  };
}

function toEvidence(
  stepId: string,
  output: ReturnType<typeof createAiNewsAcceptanceOutput>,
  durationSeconds: number,
  video: AiNewsFixtureMedia,
): NewsArtifactEvidence[] {
  const definition = AI_NEWS_VIDEO_VERSION_1.steps.find((candidate) => candidate.id === stepId);
  if (!definition) throw new Error(`Unknown step ${stepId}`);
  return definition.outputs.map((spec) => {
    const value = output.outputs[spec.key];
    const file = output.files.find((candidate) => candidate.outputKey === spec.key);
    const content =
      spec.kind === 'TEXT'
        ? String(value ?? '')
        : spec.kind === 'FILE'
          ? ''
          : JSON.stringify(value);
    const fileHash = file ? hash(file.bytes) : hash(content);
    const metadata: Record<string, unknown> = {};
    if (file) {
      Object.assign(metadata, {
        contentHash: fileHash,
        sizeBytes: file.bytes.byteLength,
        path: file.relativePath,
        extension: file.relativePath.slice(file.relativePath.lastIndexOf('.')),
        mediaType: file.mediaType,
      });
      if (spec.key === 'news.voiceover') metadata.durationSeconds = durationSeconds;
      if (spec.key === 'news.video.draft') {
        Object.assign(metadata, {
          contentHash: video.contentHash,
          sizeBytes: video.sizeBytes,
          path: video.path,
          extension: '.mp4',
          mediaType: 'video/mp4',
          durationSeconds: video.durationSeconds,
          width: video.width,
          height: video.height,
          videoCodec: video.videoCodec,
          audioCodec: video.audioCodec,
          hasAudio: video.hasAudio,
        });
      }
    }
    if (
      output.researchSources.length &&
      ['news.candidates', 'news.source_packets'].includes(spec.key)
    ) {
      metadata.researchSources = JSON.stringify(output.researchSources);
    }
    return {
      key: spec.key,
      artifactId: `${stepId}-${spec.key.replaceAll('.', '-')}`,
      kind: spec.kind,
      content,
      contentHash: workflowHash({ content, metadata }),
      metadata,
    };
  });
}

function buildAcceptanceCase(inputValue: unknown): NewsArtifactEvidence[][] {
  const inputs = validateNewsInputs(inputValue);
  const duration = inputs.targetDurationSeconds as number;
  const video = testVideo(duration);
  let priorArtifacts: NewsArtifactEvidence[] = [];
  const stepResults: NewsArtifactEvidence[][] = [];
  for (const step of AI_NEWS_VIDEO_VERSION_1.steps) {
    const output = createAiNewsAcceptanceOutput({
      stepId: step.id,
      workflowInputs: inputs,
      priorArtifacts,
      outputMedia: step.id === 'N12' ? video : undefined,
    });
    const producedArtifacts = toEvidence(step.id, output, duration, video);
    for (const artifact of producedArtifacts.filter((item) => item.kind === 'TEXT')) {
      const spec = step.outputs.find((item) => item.key === artifact.key)!;
      const contract = AI_NEWS_VIDEO_CONTRACTS.find((item) => item.contractId === spec.contractId)!;
      if (contract.validator.type === 'TEXT_RULES')
        expect(artifact.content.trim().length).toBeGreaterThanOrEqual(contract.validator.minLength);
    }
    validateNewsStep({
      version: AI_NEWS_VIDEO_VERSION_1,
      stepId: step.id,
      workflowInputs: inputs,
      priorArtifacts: priorArtifacts.filter((artifact) =>
        step.inputs.some((input) => input.outputKey === artifact.key),
      ),
      producedArtifacts,
    });
    stepResults.push(producedArtifacts);
    priorArtifacts = [...priorArtifacts, ...producedArtifacts];
  }
  return stepResults;
}

function prepareStep(stepId: string, inputValue: unknown = AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short) {
  const workflowInputs = validateNewsInputs(inputValue);
  const duration = workflowInputs.targetDurationSeconds as number;
  const video = testVideo(duration);
  let priorArtifacts: NewsArtifactEvidence[] = [];
  for (const step of AI_NEWS_VIDEO_VERSION_1.steps) {
    const output = createAiNewsAcceptanceOutput({
      stepId: step.id,
      workflowInputs,
      priorArtifacts,
      outputMedia: step.id === 'N12' ? video : undefined,
    });
    const producedArtifacts = toEvidence(step.id, output, duration, video);
    const declaredKeys = new Set(step.inputs.map((input) => input.outputKey));
    const declaredArtifacts = priorArtifacts.filter((artifact) => declaredKeys.has(artifact.key));
    if (step.id === stepId) {
      return {
        version: AI_NEWS_VIDEO_VERSION_1,
        stepId,
        workflowInputs,
        priorArtifacts: declaredArtifacts,
        producedArtifacts,
      };
    }
    validateNewsStep({
      version: AI_NEWS_VIDEO_VERSION_1,
      stepId: step.id,
      workflowInputs,
      priorArtifacts: declaredArtifacts,
      producedArtifacts,
    });
    priorArtifacts = [...priorArtifacts, ...producedArtifacts];
  }
  throw new Error(`Unknown step ${stepId}`);
}

function rewriteJsonArtifact(
  artifacts: readonly NewsArtifactEvidence[],
  key: string,
  rewrite: (value: Record<string, unknown>) => void,
): NewsArtifactEvidence[] {
  return artifacts.map((artifact) => {
    if (artifact.key !== key) return artifact;
    const value = JSON.parse(artifact.content) as Record<string, unknown>;
    rewrite(value);
    const content = JSON.stringify(value);
    const contentHash = hash(content);
    const metadata = { ...artifact.metadata };
    if (Object.hasOwn(metadata, 'contentHash')) metadata.contentHash = contentHash;
    if (metadata.acceptedSourceReport === 1) metadata.sourceReportHash = contentHash;
    return { ...artifact, content, contentHash, metadata };
  });
}

function withAcceptedSourceReport(
  artifacts: readonly NewsArtifactEvidence[],
  outputKey: string,
): NewsArtifactEvidence[] {
  return artifacts.map((artifact) => {
    if (artifact.key !== outputKey) return artifact;
    const metadata = Object.fromEntries(
      Object.entries(artifact.metadata).filter(([key]) => key !== 'researchSources'),
    );
    return {
      ...artifact,
      metadata: {
        ...metadata,
        acceptedSourceReport: 1,
        sourceReportId: 'external-accepted-source-report-1',
        sourceReportHash: artifact.contentHash,
        contentHash: artifact.contentHash,
        targetArtifactId: outputKey,
      },
    };
  });
}

describe('AI news official builtin package v1', () => {
  it('exposes the official immutable 14-step package with seven user phases', () => {
    expect(AI_NEWS_VIDEO_PACKAGE.kind).toBe('OFFICIAL');
    expect(AI_NEWS_VIDEO_VERSION_1.definition.source).toBe('BUILTIN');
    expect(AI_NEWS_VIDEO_VERSION_1.steps.map((step) => step.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `N${String(index + 1).padStart(2, '0')}`),
    );
    expect(AI_NEWS_VIDEO_PHASES.map((phase) => phase.id)).toEqual([
      'collection',
      'verification',
      'planning',
      'script',
      'assets',
      'production',
      'review',
    ]);
    expect(AI_NEWS_VIDEO_VERSION_1.steps.at(-1)).toMatchObject({
      id: 'N14',
      type: 'DECISION',
      confirmationRequired: true,
      outputs: [],
    });
    expect(
      AI_NEWS_VIDEO_VERSION_1.edges.some(
        (edge) => edge.fromStepId === 'N14' && edge.toStepId === null,
      ),
    ).toBe(true);
    expect(AI_NEWS_VIDEO_CONTRACTS.length).toBeGreaterThanOrEqual(15);
  });

  it('accepts all three bounded AP-007 acceptance input cases without inventing defaults', () => {
    expect(validateNewsInputs(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short)).toMatchObject({
      targetDurationSeconds: 60,
    });
    expect(validateNewsInputs(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.weekly)).toMatchObject({
      targetDurationSeconds: 300,
    });
    expect(validateNewsInputs(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.productExplainer)).toMatchObject({
      narrationMode: 'HUMAN',
    });
    expect(() =>
      validateNewsInputs({ ...AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short, extra: 'not allowed' }),
    ).toThrow();
    expect(() =>
      validateNewsInputs({
        ...AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short,
        targetStoryCount: { min: 4, max: 2 },
      }),
    ).toThrow();
    expect(() =>
      validateNewsInputs({
        ...AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short,
        timeRange: { from: '2026-02-30T00:00:00Z', to: '2026-10-02T00:00:00Z' },
      }),
    ).toThrow();
  });

  it('stays within the frozen definition and JSON contract bounds', () => {
    expect(JSON.stringify(AI_NEWS_VIDEO_VERSION_1).length).toBeLessThanOrEqual(120_000);
    expect(AI_NEWS_VIDEO_CONTRACTS.length).toBeLessThanOrEqual(64);
    expect(() => validateWorkflowVersion(AI_NEWS_VIDEO_VERSION_1)).not.toThrow();
  });

  it('validates an artifact-first short through all fourteen steps and final confirmation gate', () => {
    const steps = buildAcceptanceCase(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short);
    expect(steps).toHaveLength(14);
    expect(steps.at(-1)).toEqual([]);
    const candidates = JSON.parse(steps[0]![0]!.content) as { candidates: unknown[] };
    const clusters = JSON.parse(steps[1]![0]!.content) as { clusters: unknown[] };
    expect(candidates.candidates).toHaveLength(2);
    expect(clusters.clusters).toHaveLength(1);
    const finalVideo = steps[11]!.find((item) => item.key === 'news.video.draft')!;
    const qa = JSON.parse(steps[12]!.find((item) => item.key === 'news.qa_report')!.content) as {
      factualChecks: unknown[];
    };
    expect(finalVideo.metadata.path).toContain('N12-attempt-1');
    expect(qa.factualChecks).toHaveLength(1);
  });

  it.each([
    ['60-second single-topic Short', AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short, 1],
    ['five-minute weekly roundup', AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.weekly, 3],
    ['single product-release explainer', AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.productExplainer, 1],
  ])('runs the full deterministic acceptance fixture: %s', (_name, input, minimumStories) => {
    const steps = buildAcceptanceCase(input);
    const clusters = JSON.parse(steps[1]![0]!.content) as { clusters: unknown[] };
    const sourcePackets = JSON.parse(steps[2]![0]!.content) as {
      stories: unknown[];
      sources: unknown[];
    };
    const scriptMap = JSON.parse(steps[6]![1]!.content) as { segments: unknown[] };
    expect(steps).toHaveLength(14);
    expect(clusters.clusters).toHaveLength(minimumStories);
    expect(sourcePackets.stories).toHaveLength(minimumStories);
    expect(sourcePackets.sources.length).toBe(minimumStories * 2);
    expect(scriptMap.segments).toHaveLength(minimumStories);
    expect(steps[13]).toEqual([]); // N14 asks for explicit confirmation; it does not publish or auto-complete.
  });

  it('rejects an unverified claim from reaching the script even when the script map references it', () => {
    const input = validateNewsInputs(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short);
    let priorArtifacts: NewsArtifactEvidence[] = [];
    for (const step of AI_NEWS_VIDEO_VERSION_1.steps.slice(0, 6)) {
      const output = createAiNewsAcceptanceOutput({
        stepId: step.id,
        workflowInputs: input,
        priorArtifacts,
      });
      const video = testVideo(60);
      const produced = toEvidence(step.id, output, 60, video);
      validateNewsStep({
        version: AI_NEWS_VIDEO_VERSION_1,
        stepId: step.id,
        workflowInputs: input,
        priorArtifacts,
        producedArtifacts: produced,
      });
      priorArtifacts = [...priorArtifacts, ...produced];
    }
    const verifiedArtifact = priorArtifacts.find(
      (artifact) => artifact.key === 'news.verified_claims',
    )!;
    const verification = JSON.parse(verifiedArtifact.content) as {
      claims: Array<Record<string, unknown>>;
    };
    verification.claims[0]!.status = 'UNVERIFIED';
    verification.claims[0]!.scriptEligible = false;
    const changed = JSON.stringify(verification);
    priorArtifacts = priorArtifacts.map((artifact) =>
      artifact.key === 'news.verified_claims'
        ? { ...artifact, content: changed, contentHash: hash(changed) }
        : artifact,
    );
    const output = createAiNewsAcceptanceOutput({
      stepId: 'N07',
      workflowInputs: input,
      priorArtifacts,
    });
    const produced = toEvidence('N07', output, 60, testVideo(60));
    expect(() =>
      validateNewsStep({
        version: AI_NEWS_VIDEO_VERSION_1,
        stepId: 'N07',
        workflowInputs: input,
        priorArtifacts,
        producedArtifacts: produced,
      }),
    ).toThrow(/ineligible|UNVERIFIED/i);
  });

  it('requires durable source provenance rather than a synthetic claim of research', () => {
    const workflowInputs = validateNewsInputs(AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short);
    const output = createAiNewsAcceptanceOutput({
      stepId: 'N01',
      workflowInputs,
      priorArtifacts: [],
    });
    const producedArtifacts = toEvidence(
      'N01',
      { ...output, researchSources: [] },
      60,
      testVideo(60),
    );
    expect(() =>
      validateNewsStep({
        version: AI_NEWS_VIDEO_VERSION_1,
        stepId: 'N01',
        workflowInputs,
        priorArtifacts: [],
        producedArtifacts,
      }),
    ).toThrow(/source|URL/i);
  });

  it.each(['N01', 'N03'] as const)(
    'accepts a Main-marked typed Human Bridge source report for %s',
    (stepId) => {
      const context = prepareStep(stepId);
      const outputKey = stepId === 'N01' ? 'news.candidates' : 'news.source_packets';
      const producedArtifacts = withAcceptedSourceReport(context.producedArtifacts, outputKey);
      expect(() => validateNewsStep({ ...context, producedArtifacts })).not.toThrow();
    },
  );

  it('keeps accepted report byte hashes distinct from Workflow artifact envelope hashes', () => {
    const context = prepareStep('N01');
    const accepted = withAcceptedSourceReport(context.producedArtifacts, 'news.candidates');
    const producedArtifacts = accepted.map((artifact) =>
      artifact.key === 'news.candidates'
        ? { ...artifact, contentHash: hash('Workflow artifact envelope and provenance') }
        : artifact,
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts })).not.toThrow();
  });

  it('rejects an accepted source report marker that points at the wrong output contract', () => {
    const context = prepareStep('N01');
    const accepted = withAcceptedSourceReport(context.producedArtifacts, 'news.candidates');
    const producedArtifacts = accepted.map((artifact) =>
      artifact.key === 'news.candidates'
        ? {
            ...artifact,
            metadata: {
              ...artifact.metadata,
              targetArtifactId: 'external-accepted-source-report-1',
            },
          }
        : artifact,
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts })).toThrow(/source|URL/i);
  });

  it('rejects an accepted source report whose byte hash does not match its frozen file hash', () => {
    const context = prepareStep('N01');
    const accepted = withAcceptedSourceReport(context.producedArtifacts, 'news.candidates');
    const producedArtifacts = accepted.map((artifact) =>
      artifact.key === 'news.candidates'
        ? {
            ...artifact,
            metadata: { ...artifact.metadata, sourceReportHash: hash('different report bytes') },
          }
        : artifact,
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts })).toThrow(/source|URL/i);
  });

  it('rejects duplicate or missing candidates in the N02 partition', () => {
    const duplicateContext = prepareStep('N02');
    const duplicated = rewriteJsonArtifact(
      duplicateContext.producedArtifacts,
      'news.story_clusters',
      (value) => {
        const clusters = value.clusters as Array<Record<string, unknown>>;
        const candidateIds = clusters[0]!.candidateIds as string[];
        clusters[0]!.candidateIds = [...candidateIds, candidateIds[0]!];
      },
    );
    expect(() => validateNewsStep({ ...duplicateContext, producedArtifacts: duplicated })).toThrow(
      /candidate.*duplicated|omitted/i,
    );

    const missingContext = prepareStep('N02');
    const missing = rewriteJsonArtifact(
      missingContext.producedArtifacts,
      'news.story_clusters',
      (value) => {
        const clusters = value.clusters as Array<Record<string, unknown>>;
        const candidateIds = clusters[0]!.candidateIds as string[];
        clusters[0]!.candidateIds = candidateIds.slice(1);
      },
    );
    expect(() => validateNewsStep({ ...missingContext, producedArtifacts: missing })).toThrow(
      /candidate.*omitted|every candidate/i,
    );
  });

  it('rejects a source claim that cites another story’s source in N03', () => {
    const context = prepareStep('N03', AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.weekly);
    const crossed = rewriteJsonArtifact(
      context.producedArtifacts,
      'news.source_packets',
      (value) => {
        const claims = value.claims as Array<Record<string, unknown>>;
        const sources = value.sources as Array<Record<string, unknown>>;
        const foreignSource = sources.find((source) => source.storyId !== claims[0]!.storyId)!;
        claims[0]!.sourceIds = [
          ...(claims[0]!.sourceIds as string[]),
          foreignSource.sourceId as string,
        ];
      },
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts: crossed })).toThrow(
      /claim.*source|story/i,
    );
  });

  it('rejects a script segment that cites another story’s verified claim', () => {
    const context = prepareStep('N07', AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.weekly);
    const crossed = rewriteJsonArtifact(
      context.producedArtifacts,
      'news.script_claim_map',
      (value) => {
        const segments = value.segments as Array<Record<string, unknown>>;
        segments[0]!.claimIds = ['claim-2'];
      },
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts: crossed })).toThrow(
      /script claim.*cross-story|unknown/i,
    );
  });

  it('rejects an asset registry entry without a rights basis', () => {
    const context = prepareStep('N10');
    const missingRights = rewriteJsonArtifact(
      context.producedArtifacts,
      'news.asset_registry',
      (value) => {
        const assets = value.assets as Array<Record<string, unknown>>;
        assets[0]!.rightsBasis = '';
      },
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts: missingRights })).toThrow(
      /rights|provenance/i,
    );
  });

  it('rejects malformed voice hashes and video metadata inconsistent with its render manifest', () => {
    const voiceContext = prepareStep('N11');
    const wrongVoiceHash = voiceContext.producedArtifacts.map((artifact) =>
      artifact.key === 'news.voiceover'
        ? { ...artifact, metadata: { ...artifact.metadata, contentHash: 'invalid-byte-hash' } }
        : artifact,
    );
    expect(() => validateNewsStep({ ...voiceContext, producedArtifacts: wrongVoiceHash })).toThrow(
      /voice file\/timing metadata/i,
    );

    const videoContext = prepareStep('N12');
    const wrongVideoHash = videoContext.producedArtifacts.map((artifact) =>
      artifact.key === 'news.video.draft'
        ? { ...artifact, metadata: { ...artifact.metadata, contentHash: hash('wrong video') } }
        : artifact,
    );
    expect(() => validateNewsStep({ ...videoContext, producedArtifacts: wrongVideoHash })).toThrow(
      /render manifest.*inspected MP4/i,
    );

    const wrongVideoDuration = videoContext.producedArtifacts.map((artifact) =>
      artifact.key === 'news.video.draft'
        ? {
            ...artifact,
            metadata: {
              ...artifact.metadata,
              durationSeconds: Number(artifact.metadata.durationSeconds) + 1,
            },
          }
        : artifact,
    );
    expect(() =>
      validateNewsStep({ ...videoContext, producedArtifacts: wrongVideoDuration }),
    ).toThrow(/render manifest.*inspected MP4/i);
  });

  it('rejects an undeclared N13 QA revision code', () => {
    const context = prepareStep('N13');
    const invalidCode = rewriteJsonArtifact(
      context.producedArtifacts,
      'news.qa_review',
      (value) => {
        value.verdict = 'REVISE';
        value.revisionCode = 'PUBLISH';
      },
    );
    expect(() => validateNewsStep({ ...context, producedArtifacts: invalidCode })).toThrow(
      /revision.*declared/i,
    );
  });

  it('declares exactly three QA revision targets sharing a total budget of two', () => {
    const revisionEdges = AI_NEWS_VIDEO_VERSION_1.edges.filter(
      (edge) => edge.fromStepId === 'N13' && edge.revisionCode !== undefined,
    );
    expect(revisionEdges.map((edge) => [edge.revisionCode, edge.toStepId])).toEqual([
      ['STORYBOARD', 'N09'],
      ['ASSETS', 'N10'],
      ['ASSEMBLY', 'N12'],
    ]);
    expect(revisionEdges.every((edge) => edge.revision?.maxTraversals === 2)).toBe(true);
    expect(new Set(revisionEdges.map((edge) => edge.revision?.groupId))).toEqual(
      new Set([AI_NEWS_VIDEO_REVISION_GROUPS.finalQa]),
    );
    expect(
      AI_NEWS_VIDEO_VERSION_1.revisionGroups?.find(
        (group) => group.id === AI_NEWS_VIDEO_REVISION_GROUPS.finalQa,
      ),
    ).toMatchObject({ maxTotalTraversals: 2 });
  });
});
