import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelRequest, ModelToolResponse } from '@cultivation/application';
import type {
  ToolDescriptor,
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowInputs,
  WorkflowStepRun,
} from '@cultivation/domain';
import { inspectNewsMediaBytes } from './w21-media-validation.js';

type NewsArtifactEvidence = Pick<
  WorkflowArtifact,
  'kind' | 'content' | 'contentHash' | 'metadata'
> & { key: string; artifactId: string };
type FixtureMedia = {
  path: string;
  contentHash: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  hasAudio: boolean | 0 | 1;
  extension?: string;
  mediaType?: string;
  bytes?: Uint8Array;
};
type AcceptanceFactoryInput = {
  stepId: string;
  workflowInputs: WorkflowInputs;
  priorArtifacts: readonly NewsArtifactEvidence[];
  inputArtifactIds?: readonly string[];
  outputMedia?: FixtureMedia;
  reviewVerdict?: 'PASS' | 'REVISE' | 'FAIL';
  revisionCode?: 'STORYBOARD' | 'ASSETS' | 'ASSEMBLY';
  outputPathPrefix?: string;
};
type AcceptanceFactoryOutput = {
  outputs: Readonly<Record<string, unknown>>;
  files: readonly {
    outputKey: string;
    relativePath: string;
    bytes: Uint8Array;
    mediaType: string;
  }[];
  researchSources: readonly { url: string; contentHash: string }[];
};
type AcceptanceFactoryModule = {
  createAiNewsAcceptanceOutput(options: AcceptanceFactoryInput): AcceptanceFactoryOutput;
};
type FixtureToolEvidence = {
  artifactFiles?: readonly { path: string; contentHash: string }[];
  researchSources?: readonly { url: string; contentHash: string }[];
};

const AI_NEWS_VIDEO_DEFINITION_ID = 'official.ai-news-video';
const MAX_TOOL_EVIDENCE_ITEMS = 20;
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MEDIA_NAMES = [
  'short60s.mp4',
  'short.mp4',
  'weekly300s.mp4',
  'weekly.mp4',
  'explainer180s.mp4',
  'explainer120s.mp4',
  'explainer.mp4',
];

let factoryModule: Promise<AcceptanceFactoryModule> | undefined;
function loadAcceptanceFactory(): Promise<AcceptanceFactoryModule> {
  // Main imports this file only under --gate1-fake-model + --w21-fake-news. Keep the
  // acceptance data itself lazy too, so production bootstrap never loads test fixtures.
  factoryModule ??= import(
    '../../../../packages/application/src/builtin/ai-news-video/test-data.js'
  ) as Promise<AcceptanceFactoryModule>;
  return factoryModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeWorkflowId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error('W2.1 fixture received an invalid workflow ID');
  return value;
}

function getPriorArtifacts(detail: WorkflowDetail): NewsArtifactEvidence[] {
  const artifacts = new Map(detail.artifacts.map((artifact) => [artifact.id, artifact]));
  const bindings = detail.bindings
    .filter((binding) => binding.role === 'OUTPUT')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestByProducerOutputKey = new Map<string, NewsArtifactEvidence>();
  for (const binding of bindings) {
    const artifact = artifacts.get(binding.artifactId);
    if (!artifact) continue;
    // Use the producer's OUTPUT key. Consumer aliases can differ between steps.
    latestByProducerOutputKey.set(binding.key, {
      key: binding.key,
      artifactId: artifact.id,
      kind: artifact.kind,
      content: artifact.content,
      contentHash: artifact.contentHash,
      metadata: artifact.metadata,
    });
  }
  return [...latestByProducerOutputKey.values()];
}

function getInputArtifactIds(detail: WorkflowDetail, step: WorkflowStepRun): string[] {
  return detail.bindings
    .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
    .map((binding) => binding.artifactId);
}

function extractSuccessfulToolEvidence(request: ModelRequest): FixtureToolEvidence[] {
  return request.messages.flatMap((message) => {
    if (message.role !== 'tool') return [];
    return message.content.flatMap((part) => {
      const value = part.output.value;
      if (!isRecord(value) || value.ok !== true || typeof value.content !== 'string') return [];
      try {
        const payload: unknown = JSON.parse(value.content);
        const evidence = isRecord(payload) ? payload.structuredContent : undefined;
        if (!isRecord(evidence) || !isRecord(evidence.workflowEvidence)) return [];
        const workflowEvidence = evidence.workflowEvidence;
        const artifactFiles = Array.isArray(workflowEvidence.artifactFiles)
          ? workflowEvidence.artifactFiles.slice(0, MAX_TOOL_EVIDENCE_ITEMS).flatMap((item) =>
              isRecord(item) &&
              typeof item.path === 'string' &&
              /^[a-f0-9]{64}$/.test(String(item.contentHash))
                ? [
                    {
                      path: item.path.replaceAll('\\', '/'),
                      contentHash: String(item.contentHash),
                    },
                  ]
                : [],
            )
          : undefined;
        const researchSources = Array.isArray(workflowEvidence.researchSources)
          ? workflowEvidence.researchSources
              .slice(0, MAX_TOOL_EVIDENCE_ITEMS)
              .flatMap((item) =>
                isRecord(item) &&
                typeof item.url === 'string' &&
                /^[a-f0-9]{64}$/.test(String(item.contentHash))
                  ? [{ url: item.url, contentHash: String(item.contentHash) }]
                  : [],
              )
          : undefined;
        return [
          {
            ...(artifactFiles ? { artifactFiles } : {}),
            ...(researchSources ? { researchSources } : {}),
          },
        ];
      } catch {
        return [];
      }
    });
  });
}

function sameResearchFacts(
  expected: readonly { url: string; contentHash: string }[],
  actual: readonly { url: string; contentHash: string }[],
): boolean {
  const normalize = (items: readonly { url: string; contentHash: string }[]) =>
    JSON.stringify(
      [
        ...new Map(
          items.map((item) => [item.url, { url: item.url, contentHash: item.contentHash }]),
        ).values(),
      ].sort((left, right) => left.url.localeCompare(right.url)),
    );
  return normalize(expected) === normalize(actual);
}

function pickMediaFixture(fixtureRoot: string, targetDurationSeconds: number) {
  const files = MEDIA_NAMES.flatMap((name) => {
    const path = join(fixtureRoot, name);
    if (!existsSync(path)) return [];
    const bytes = readFileSync(path);
    const inspected = inspectNewsMediaBytes(bytes);
    if (
      inspected.container !== 'MP4' ||
      inspected.mediaType !== 'video/mp4' ||
      inspected.hasAudio !== 1 ||
      !inspected.width ||
      !inspected.height ||
      !inspected.videoCodec ||
      !inspected.audioCodec
    )
      return [];
    return [{ name, path, bytes, inspected }];
  });
  const selected = files.sort(
    (left, right) =>
      Math.abs(left.inspected.durationSeconds - targetDurationSeconds) -
      Math.abs(right.inspected.durationSeconds - targetDurationSeconds),
  )[0];
  if (!selected) throw new Error('No actual AAC/H.264 test MP4 is available');
  if (
    Math.abs(selected.inspected.durationSeconds - targetDurationSeconds) >
    Math.max(10, targetDurationSeconds * 0.2)
  )
    throw new Error('No test MP4 duration matches the frozen workflow input');
  return selected;
}

function mediaForOutput(
  fixtureRoot: string,
  targetDurationSeconds: number,
  outputPath: string,
): FixtureMedia & { sourceMediaName: string } {
  const selected = pickMediaFixture(fixtureRoot, targetDurationSeconds);
  const { inspected, bytes } = selected;
  return {
    path: outputPath,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    durationSeconds: inspected.durationSeconds,
    width: inspected.width!,
    height: inspected.height!,
    videoCodec: inspected.videoCodec!,
    audioCodec: inspected.audioCodec!,
    hasAudio: inspected.hasAudio,
    extension: '.mp4',
    mediaType: 'video/mp4',
    bytes,
    sourceMediaName: basename(selected.path),
  };
}

function successfulResearchSources(evidence: readonly FixtureToolEvidence[]) {
  return evidence.flatMap((item) => item.researchSources ?? []);
}

function verifiedAssemblyFile(
  evidence: readonly FixtureToolEvidence[],
  outputPath: string,
  contentHash: string,
): boolean {
  return evidence.some((item) =>
    item.artifactFiles?.some(
      (file) => file.path === outputPath && file.contentHash === contentHash,
    ),
  );
}

function toolPurpose(detail: WorkflowDetail, step: WorkflowStepRun): string | undefined {
  const definition = detail.version.steps.find((item) => item.id === step.stepId);
  return (
    definition as
      | (typeof definition & {
          executionRequirements?: { toolPurpose?: string };
        })
      | undefined
  )?.executionRequirements?.toolPurpose;
}

function serializedModelOutput(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  output: AcceptanceFactoryOutput,
): string {
  const definition = detail.version.steps.find((item) => item.id === step.stepId);
  if (!definition) throw new Error(`W2.1 fixture step ${step.stepId} is not in the frozen version`);
  const textualOutputs = definition.outputs.filter(
    (spec) => spec.kind === 'JSON' || spec.kind === 'TEXT',
  );
  const modelOutputs = Object.fromEntries(
    textualOutputs
      .filter((spec) => Object.hasOwn(output.outputs, spec.key))
      .map((spec) => [spec.key, output.outputs[spec.key]]),
  );
  if (textualOutputs.length === 0) return JSON.stringify({ ok: true });
  if (definition.outputs.length > 1) return JSON.stringify({ outputs: modelOutputs });
  const outputKey = textualOutputs[0]!.key;
  if (!Object.hasOwn(modelOutputs, outputKey))
    throw new Error(`W2.1 fixture did not produce declared output ${outputKey}`);
  return JSON.stringify(modelOutputs[outputKey]);
}

/** Deterministic AP-007 provider fixture; Main supplies only the current workflow attempt. */
export class NewsWorkflowFixtureGateway extends FakeModelGateway {
  private readonly fixtureRoot: string;

  constructor(
    private readonly resolveContext: (
      request: ModelRequest,
    ) => { detail: WorkflowDetail; step: WorkflowStepRun } | null,
    fixtureRoot: string,
  ) {
    super();
    this.fixtureRoot = join(fixtureRoot);
  }

  override async generate(request: ModelRequest) {
    try {
      return await this.generateFixture(request);
    } catch (error) {
      // This gateway is enabled only by explicit offline smoke flags.
      console.error(
        'W21_OFFLINE_FIXTURE_FAILURE',
        error instanceof Error ? error.message : 'unknown',
      );
      throw error;
    }
  }

  private async generateFixture(request: ModelRequest) {
    const base = await super.generate(request);
    if (request.externalWorkContext) {
      return {
        ...base,
        text: JSON.stringify({
          ok: true,
          summary: 'Human Bridge delivery accepted for deterministic workflow validation.',
        }),
      };
    }
    const context = this.resolveContext(request);
    if (!context || context.detail.version.definition.id !== AI_NEWS_VIDEO_DEFINITION_ID)
      return base;

    const { detail, step } = context;
    const workflowInputs = detail.run.inputSnapshot ?? ({} as WorkflowInputs);
    const priorArtifacts = getPriorArtifacts(detail);
    const inputArtifactIds = getInputArtifactIds(detail, step);
    const outputPath = `workflows/${safeWorkflowId(detail.run.id)}/${safeWorkflowId(step.id)}/output/draft.mp4`;
    const outputPathPrefix = `workflows/${safeWorkflowId(detail.run.id)}/${safeWorkflowId(step.id)}/`;
    const media = ['N12', 'N13'].includes(step.stepId)
      ? mediaForOutput(this.fixtureRoot, Number(workflowInputs.targetDurationSeconds), outputPath)
      : undefined;
    const acceptance = await (
      await loadAcceptanceFactory()
    ).createAiNewsAcceptanceOutput({
      stepId: step.stepId,
      workflowInputs,
      priorArtifacts,
      inputArtifactIds,
      ...(step.stepId === 'N10' ? { outputPathPrefix } : {}),
      ...(media ? { outputMedia: media } : {}),
      ...(step.stepId === 'N13' &&
      step.attempt === 1 &&
      workflowInputs.targetDurationSeconds === 300
        ? { reviewVerdict: 'REVISE' as const, revisionCode: 'ASSEMBLY' as const }
        : {}),
    });

    const evidence = extractSuccessfulToolEvidence(request);
    const purpose = toolPurpose(detail, step);
    if (purpose === 'RESEARCH') {
      const actualSources = successfulResearchSources(evidence);
      if (!actualSources.length || !sameResearchFacts(acceptance.researchSources, actualSources))
        throw new Error(
          `W2.1 ${step.stepId} research output requires matching successful MCP source evidence`,
        );
    }
    if (step.stepId === 'N12') {
      if (!media || !verifiedAssemblyFile(evidence, outputPath, media.contentHash))
        throw new Error('W2.1 video output requires a successful MCP file hash proof');
      if (
        !acceptance.files.some(
          (file) => file.outputKey === 'news.video.draft' && file.relativePath === outputPath,
        )
      )
        throw new Error('W2.1 video fixture file path does not match this Step attempt');
    }
    return { ...base, text: serializedModelOutput(detail, step, acceptance) };
  }

  override async generateWithTools(
    request: Parameters<NonNullable<FakeModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const context = this.resolveContext(request);
    if (!context || context.detail.version.definition.id !== AI_NEWS_VIDEO_DEFINITION_ID)
      return super.generateWithTools(request);
    const { detail, step } = context;
    const purpose = toolPurpose(detail, step);
    if (purpose !== 'RESEARCH' && purpose !== 'VIDEO_ASSEMBLY')
      return super.generateWithTools(request);
    if (request.messages.some((message) => message.role === 'tool'))
      return super.generateWithTools(request);

    const tool = request.tools.find((candidate) =>
      (candidate as ToolDescriptor & { workflowPurposes?: string[] }).workflowPurposes?.includes(
        purpose,
      ),
    );
    if (!tool) throw new Error(`W2.1 fixture is missing a permitted ${purpose} MCP tool`);

    const workflowInputs = detail.run.inputSnapshot ?? ({} as WorkflowInputs);
    const input: Record<string, unknown> = {
      stepId: step.stepId,
      workflowRunId: safeWorkflowId(detail.run.id),
      stepRunId: safeWorkflowId(step.id),
      topicScope: workflowInputs.topicScope,
      targetDurationSeconds: workflowInputs.targetDurationSeconds,
      targetStoryCount: workflowInputs.targetStoryCount,
      timeRange: workflowInputs.timeRange,
    };
    if (purpose === 'VIDEO_ASSEMBLY') {
      const outputPath = `workflows/${safeWorkflowId(detail.run.id)}/${safeWorkflowId(step.id)}/output/draft.mp4`;
      const media = mediaForOutput(
        this.fixtureRoot,
        Number(workflowInputs.targetDurationSeconds),
        outputPath,
      );
      input.sourceMediaName = media.sourceMediaName;
      input.outputPath = outputPath;
    }
    const base = await super.generate(request);
    return {
      ...base,
      text: '',
      toolCalls: [{ id: `w21-${randomUUID()}`, toolId: tool.id, input }],
    };
  }
}
