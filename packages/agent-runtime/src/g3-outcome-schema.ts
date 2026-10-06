import { z } from 'zod';

const id = z.string().min(1).max(128);
const requirement = z
  .object({
    role: z.string().min(1).max(80),
    artifactKinds: z.array(z.string().min(1).max(32)).max(8),
    mimeTypes: z.array(z.string().min(1).max(100)).max(8),
    required: z.boolean(),
  })
  .strict();

/** Adapter output shape only. Main independently validates authority and Artifact provenance. */
export const participantOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('RESULT'),
      publicResult: z.string().max(4_000).optional(),
      artifactRefs: z
        .array(
          z
            .object({
              id,
              kind: z.string().min(1).max(32),
              mimeType: z.string().min(1).max(100),
              contentHash: z.string().regex(/^[a-f0-9]{64}$/),
              sizeBytes: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('NEEDS_INPUT'),
      requirements: z.array(requirement).min(1).max(8),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('NEEDS_CAPABILITY'),
      capability: z.enum([
        'GENERAL_REASONING',
        'LONG_CONTEXT_REASONING',
        'AGENTIC_EXECUTION',
        'CODING',
        'TOOL_USE',
        'VISUAL_UNDERSTANDING',
        'IMAGE_GENERATION',
        'IMAGE_EDITING',
        'VIDEO_GENERATION',
        'VIDEO_EDITING',
        'SPEECH_UNDERSTANDING',
        'SPEECH_GENERATION',
        'SPEECH_TO_SPEECH',
        'MUSIC_GENERATION',
      ]),
      requiredFeatures: z.array(z.string().min(1).max(80)).max(24),
      requestedInputs: z.array(requirement).max(8),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('FAILED_RETRYABLE'),
      errorCode: z.string().regex(/^[A-Z0-9_]{1,80}$/),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('FAILED_TERMINAL'),
      errorCode: z.string().regex(/^[A-Z0-9_]{1,80}$/),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const generationProposalSchema = z
  .object({
    capability: z.enum([
      'IMAGE_GENERATION',
      'IMAGE_EDITING',
      'VIDEO_GENERATION',
      'SPEECH_GENERATION',
      'MUSIC_GENERATION',
    ]),
    requiredFeatures: z.array(z.string().min(1).max(80)).max(24),
    parameters: z.record(
      z.string(),
      z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
    ),
    inputRequirements: z.array(requirement).max(8).optional(),
    reviewCapability: z.enum(['VISUAL_UNDERSTANDING', 'SPEECH_UNDERSTANDING']).optional(),
  })
  .strict();
