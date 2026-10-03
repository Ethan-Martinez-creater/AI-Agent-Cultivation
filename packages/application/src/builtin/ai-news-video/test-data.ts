import { createHash } from 'node:crypto';
import type { WorkflowInputs } from '@cultivation/domain';
import {
  AI_NEWS_VIDEO_ACCEPTANCE_INPUTS,
  renderNewsScript,
  type NewsArtifactEvidence,
} from './v1.js';

/** This factory is test-only. Production bootstrap must never import or register its output. */
export interface AiNewsFixtureFile {
  outputKey: string;
  relativePath: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface AiNewsFixtureMedia {
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
}

export interface CreateAiNewsAcceptanceOutputOptions {
  stepId: string;
  workflowInputs: WorkflowInputs;
  priorArtifacts: readonly NewsArtifactEvidence[];
  inputArtifactIds?: readonly string[];
  outputMedia?: AiNewsFixtureMedia;
  reviewVerdict?: 'PASS' | 'REVISE' | 'FAIL';
  revisionCode?: 'STORYBOARD' | 'ASSETS' | 'ASSEMBLY';
  /** Test-only actual Step attempt directory, with trailing slash. */
  outputPathPrefix?: string;
}

export interface AiNewsAcceptanceOutput {
  outputs: Readonly<Record<string, unknown>>;
  files: readonly AiNewsFixtureFile[];
  researchSources: readonly { url: string; contentHash: string }[];
}

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const ids = (artifacts: readonly NewsArtifactEvidence[]): string[] =>
  artifacts.map((artifact) => artifact.artifactId).slice(-12);

function makeWav(durationSeconds: number): Uint8Array {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600)
    throw new Error('Test WAV fixture duration must be from 1 to 600 seconds');
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = durationSeconds * sampleRate * channels * (bitsPerSample / 8);
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  bytes.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

function review(
  artifacts: readonly NewsArtifactEvidence[],
  verdict: 'PASS' | 'REVISE' | 'FAIL',
  revisionCode?: string,
  inputArtifactIds?: readonly string[],
): Record<string, unknown> {
  return {
    verdict,
    findings: verdict === 'PASS' ? [] : ['Fixture review finding'],
    evidence: verdict === 'PASS' ? ['Bounded deterministic fixture evidence'] : [],
    summary:
      verdict === 'PASS' ? 'Fixture review passed' : 'Fixture review requires user attention',
    reviewedArtifactIds: inputArtifactIds ? [...inputArtifactIds] : ids(artifacts),
    ...(revisionCode ? { revisionCode } : {}),
  };
}

/**
 * Builds deterministic AP-007 acceptance-case outputs for fake providers and packaged smoke.
 * Claims and URLs are explicitly synthetic; they must not be presented as real news.
 */
export function createAiNewsAcceptanceOutput(
  options: CreateAiNewsAcceptanceOutputOptions,
): AiNewsAcceptanceOutput {
  const { stepId, workflowInputs, priorArtifacts } = options;
  const count = (workflowInputs.targetStoryCount as { min: number }).min;
  const duration = workflowInputs.targetDurationSeconds as number;
  const stories = Array.from({ length: count }, (_, index) => ({
    storyId: `story-${index + 1}`,
    eventKey: `synthetic-event-${index + 1}`,
    title: `合成测试事件 ${index + 1}`,
    claimId: `claim-${index + 1}`,
    claimText: `合成测试断言 ${index + 1} 仅用于验证流程与来源追溯。`,
  }));
  const candidateCount = Math.min(20, count + 1);
  const candidates = Array.from({ length: candidateCount }, (_, index) => {
    const storyIndex = index === 1 ? 0 : index > 1 ? index - 1 : index;
    const story = stories[storyIndex];
    if (!story) throw new Error('Fixture candidate does not resolve to a story');
    return {
      id: `candidate-${index + 1}`,
      eventKey: story.eventKey,
      title: `${story.title}${index === 1 ? '（重复来源）' : ''}`,
      eventDate: '2026-09-28T09:00:00.000Z',
      discoveredAt: '2026-10-01T09:00:00.000Z',
      discoverySource: 'deterministic acceptance fixture',
      url: `https://news.example.test/${story.eventKey}/${index + 1}`,
      sourceContentHash: sha256(`candidate synthetic content ${index + 1}`),
      entities: ['合成机构'],
      initialSummary: '非真实新闻数据，仅用于功能验收。',
    };
  });
  const candidatesByStory = new Map<string, string[]>();
  for (const candidate of candidates) {
    const candidateIds = candidatesByStory.get(candidate.eventKey) ?? [];
    candidateIds.push(candidate.id);
    candidatesByStory.set(candidate.eventKey, candidateIds);
  }
  const sourceRows = stories.flatMap((story) =>
    (['PRIMARY', 'INDEPENDENT_RELIABLE'] as const).map((tier, index) => {
      const url = `https://sources.example.test/${story.eventKey}/${tier.toLowerCase()}`;
      return {
        sourceId: `source-${story.storyId}-${index + 1}`,
        storyId: story.storyId,
        title: `${tier === 'PRIMARY' ? '一手' : '独立'}合成来源 ${story.storyId}`,
        url,
        contentHash: sha256(`synthetic source content ${url}`),
        tier,
        publishedAt: '2026-09-28T09:00:00.000Z',
        attribution: `${tier} synthetic fixture, not a real publication`,
      };
    }),
  );
  const sourceFacts = sourceFactsFor(candidates, sourceRows);
  const verifiedClaims = stories.map((story) => ({
    claimId: story.claimId,
    storyId: story.storyId,
    text: story.claimText,
    sourceIds: sourceRows
      .filter((source) => source.storyId === story.storyId)
      .map((source) => source.sourceId),
    status: 'VERIFIED',
    scriptEligible: true,
  }));
  const selected = stories;
  const secondsPerStory = Math.floor(duration / selected.length);
  const beats = selected.map((story, index) => ({
    beatId: `beat-${index + 1}`,
    purpose: `说明合成测试事件 ${index + 1}`,
    storyId: story.storyId,
    targetDurationSeconds:
      secondsPerStory + (index === selected.length - 1 ? duration % selected.length : 0),
    keyClaimIds: [story.claimId],
    transition: '进入下一条测试内容',
  }));
  const segments = beats.map((beat, index) => ({
    segmentId: `segment-${index + 1}`,
    beatId: beat.beatId,
    storyId: beat.storyId,
    claimIds: [...beat.keyClaimIds],
    text: stories[index]!.claimText,
  }));
  const scenes = segments.map((segment, index) => ({
    sceneId: `scene-${index + 1}`,
    beatId: segment.beatId,
    segmentIds: [segment.segmentId],
    claimIds: [...segment.claimIds],
    visualType: 'USER_PROVIDED',
    description: `测试画面 ${index + 1}`,
  }));
  const requestedAssets = scenes.map((scene, index) => ({
    assetId: `asset-${index + 1}`,
    sceneId: scene.sceneId,
    visualType: scene.visualType,
    description: `测试图片 ${index + 1}`,
    sourceRequirement: '用户提供或测试夹具提供',
    usageRequirement: '仅限本地验收',
    required: true,
  }));
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const assetFiles = requestedAssets.map((asset) => ({
    outputKey: 'news.assets',
    relativePath: `${options.outputPathPrefix ?? ''}assets/${asset.assetId}.png`,
    bytes: Uint8Array.from(pngBytes),
    mediaType: 'image/png',
  }));
  const assetRegistryRows = assetFiles.map((file, index) => ({
    assetId: requestedAssets[index]!.assetId,
    relativePath: file.relativePath,
    source: 'deterministic test fixture',
    usageMetadata: 'local acceptance only',
    rightsStatus: 'USER_PROVIDED',
    rightsBasis: 'synthetic non-production fixture',
    capturedAt: '2026-10-01T09:00:00.000Z',
    storyboardSceneIds: [requestedAssets[index]!.sceneId],
    contentHash: sha256(file.bytes),
    sizeBytes: file.bytes.byteLength,
  }));
  const assetDirectory = {
    entries: assetFiles.map((file, index) => ({
      relativePath: file.relativePath,
      contentHash: assetRegistryRows[index]!.contentHash,
      sizeBytes: assetRegistryRows[index]!.sizeBytes,
    })),
  };
  const wavBytes = makeWav(duration);
  const voiceSegments = segments.map((segment, index) => {
    const startSeconds = Math.floor((duration * index) / segments.length);
    const endSeconds =
      index === segments.length - 1
        ? duration
        : Math.floor((duration * (index + 1)) / segments.length);
    return { segmentId: segment.segmentId, startSeconds, endSeconds };
  });
  const media = options.outputMedia;
  const reviewVerdict = options.reviewVerdict ?? 'PASS';
  const scriptReview = review(priorArtifacts, reviewVerdict, undefined, options.inputArtifactIds);
  const qaReview = review(
    priorArtifacts,
    reviewVerdict,
    options.revisionCode,
    options.inputArtifactIds,
  );

  switch (stepId) {
    case 'N01':
      return {
        outputs: { 'news.candidates': { candidates } },
        files: [],
        researchSources: sourceFactsFor(candidates),
      };
    case 'N02':
      return {
        outputs: {
          'news.story_clusters': {
            clusters: [...candidatesByStory.entries()].map(([eventKey, candidateIds]) => {
              const story = stories.find((item) => item.eventKey === eventKey)!;
              return { id: story.storyId, eventKey, title: story.title, candidateIds };
            }),
            discardedCandidates: [],
          },
        },
        files: [],
        researchSources: [],
      };
    case 'N03':
      return {
        outputs: {
          'news.source_packets': {
            stories: stories.map((story) => ({
              storyId: story.storyId,
              eventKey: story.eventKey,
              title: story.title,
              candidateIds: candidates
                .filter((candidate) => candidate.eventKey === story.eventKey)
                .map((candidate) => candidate.id),
              sourceIds: sourceRows
                .filter((source) => source.storyId === story.storyId)
                .map((source) => source.sourceId),
              claimIds: [story.claimId],
            })),
            sources: sourceRows,
            claims: stories.map((story) => ({
              claimId: story.claimId,
              storyId: story.storyId,
              text: story.claimText,
              sourceIds: sourceRows
                .filter((source) => source.storyId === story.storyId)
                .map((source) => source.sourceId),
              context: '合成测试数据',
            })),
          },
        },
        files: [],
        researchSources: sourceFacts,
      };
    case 'N04':
      return {
        outputs: {
          'news.verification_review': review(
            priorArtifacts,
            'PASS',
            undefined,
            options.inputArtifactIds,
          ),
          'news.verification_report': {
            decisions: verifiedClaims.map((claim) => ({
              claimId: claim.claimId,
              status: claim.status,
              sourceIds: claim.sourceIds,
              rationale: '两个合成来源一致，仅证明测试流程。',
            })),
            storyNotes: stories.map((story) => ({ storyId: story.storyId, note: '合成验收内容' })),
          },
          'news.verified_claims': { claims: verifiedClaims },
        },
        files: [],
        researchSources: [],
      };
    case 'N05':
      return {
        outputs: {
          'news.editorial_plan': {
            selectedStoryIds: stories.map((story) => story.storyId),
            storyOrder: stories.map((story) => story.storyId),
            editorialAngle: '用合成事件验证流程结构。',
            audienceValue: '不表达真实新闻事实。',
            estimatedDurationSeconds: duration,
            discardedStories: [],
          },
        },
        files: [],
        researchSources: [],
      };
    case 'N06':
      return { outputs: { 'news.beat_map': { beats } }, files: [], researchSources: [] };
    case 'N07':
      return {
        outputs: {
          'news.script_claim_map': { segments },
          'news.script': renderNewsScript(segments),
        },
        files: [],
        researchSources: [],
      };
    case 'N08':
      return { outputs: { 'news.script_review': scriptReview }, files: [], researchSources: [] };
    case 'N09':
      return {
        outputs: {
          'news.storyboard': { scenes },
          'news.asset_manifest': { assets: requestedAssets },
        },
        files: [],
        researchSources: [],
      };
    case 'N10':
      return {
        outputs: {
          'news.asset_registry': { assets: assetRegistryRows },
          'news.assets': assetDirectory,
        },
        files: assetFiles,
        researchSources: [],
      };
    case 'N11':
      return {
        outputs: {
          'news.voice_timing': { durationSeconds: duration, segments: voiceSegments },
          'news.voiceover': null,
        },
        files: [
          {
            outputKey: 'news.voiceover',
            relativePath: 'output/voice.wav',
            bytes: wavBytes,
            mediaType: 'audio/wav',
          },
        ],
        researchSources: [],
      };
    case 'N12': {
      if (!media) throw new Error('N12 fixture requires actual packaged MP4 probe metadata');
      const priorByKey = new Map(priorArtifacts.map((artifact) => [artifact.key, artifact]));
      const sourceHash = (key: string): string => {
        const source = priorByKey.get(key);
        if (!source) throw new Error(`N12 fixture is missing render input ${key}`);
        return source.contentHash;
      };
      return {
        outputs: {
          'news.video.draft': null,
          'news.render_manifest': {
            output: {
              relativePath: media.path,
              contentHash: media.contentHash,
              sizeBytes: media.sizeBytes,
              container: 'mp4',
              videoCodec: media.videoCodec,
              audioCodec: media.audioCodec,
              width: media.width,
              height: media.height,
              durationSeconds: media.durationSeconds,
              hasAudio: Boolean(media.hasAudio),
            },
            inputs: {
              storyboardHash: sourceHash('news.storyboard'),
              assetRegistryHash: sourceHash('news.asset_registry'),
              voiceTimingHash: sourceHash('news.voice_timing'),
              scriptHash: sourceHash('news.script'),
            },
          },
          'news.production_summary': `已生成 ${duration} 秒验收成片，素材、配音与脚本引用已纳入制作清单。成片保存在本地工作区，等待事实、画面与技术质量检查，以及用户最终确认；不会自动上传或发布。`,
        },
        files: media.bytes
          ? [
              {
                outputKey: 'news.video.draft',
                relativePath: media.path,
                bytes: media.bytes,
                mediaType: 'video/mp4',
              },
            ]
          : [],
        researchSources: [],
      };
    }
    case 'N13': {
      const factualChecks = verifiedClaims.map((claim) => ({
        claimId: claim.claimId,
        status: claim.status,
        sourceIds: claim.sourceIds,
      }));
      const visualChecks = scenes.map((scene) => ({
        sceneId: scene.sceneId,
        status: 'PASS',
        summary: 'Synthetic scene is linked to a scripted segment.',
      }));
      return {
        outputs: {
          'news.qa_review': qaReview,
          'news.qa_report': {
            factualChecks,
            visualChecks,
            technicalChecks: {
              durationSeconds: media?.durationSeconds ?? duration,
              width: media?.width ?? 640,
              height: media?.height ?? 360,
              hasAudio: Boolean(media?.hasAudio ?? true),
              blackFrameCount: 0,
              subtitleStatus: 'NOT_REQUIRED',
            },
            issues: [],
          },
        },
        files: [],
        researchSources: [],
      };
    }
    case 'N14':
      return { outputs: {}, files: [], researchSources: [] };
    default:
      throw new Error(`Unknown AI news fixture step ${stepId}`);
  }
}

function sourceFactsFor(
  candidates: readonly { url: string; sourceContentHash: string }[],
  sources: readonly { url: string; contentHash: string }[] = [],
): { url: string; contentHash: string }[] {
  const merged = [
    ...candidates.map((candidate) => ({
      url: candidate.url,
      contentHash: candidate.sourceContentHash,
    })),
    ...sources,
  ];
  return [...new Map(merged.map((fact) => [fact.url, fact])).values()];
}

/** Handy typed names for future acceptance fixtures without treating them as production data. */
export const aiNewsAcceptanceFixtureInputs = AI_NEWS_VIDEO_ACCEPTANCE_INPUTS;
