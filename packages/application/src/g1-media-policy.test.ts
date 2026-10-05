import { describe, expect, it } from 'vitest';
import type { GenerationModelDescriptor, GenerationTask } from '@cultivation/domain/g1-generation';
import { validateGenerationTask } from './g1-generation.js';
import {
  GENERATION_MEDIA_POLICY,
  getGenerationMediaCeilingBytes,
  generationMetadataSizeBytes,
} from './g1-media-policy.js';

describe('G1 media safety policy', () => {
  it('accepts positive safe descriptor limits above the former 16 MiB ceiling', () => {
    const descriptor: GenerationModelDescriptor = {
      modelId: 'video-model',
      outputCapability: 'VIDEO_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: [],
      inputRoles: [],
      parameterSchema: { type: 'object', additionalProperties: false },
      outputTypes: ['video/mp4'],
      limits: {
        maxInputFiles: 0,
        maxInputBytes: 32 * 1024 * 1024,
        maxOutputBytes: 64 * 1024 * 1024,
        maxOutputs: 1,
      },
    };
    const task: GenerationTask = {
      id: 'task-1',
      targetTeammateId: 'teammate-1',
      capability: 'VIDEO_GENERATION',
      requiredFeatures: [],
      prompt: 'Create a short video',
      inputs: [],
      parameters: {},
      expectedOutput: { artifactKind: 'VIDEO', mimeTypes: ['video/mp4'] },
      outputDestination: { scope: 'APP_ARTIFACT_STORE' },
      requester: { actorType: 'USER', actorId: null },
      missionId: null,
      runId: null,
      workflowRunId: null,
      workflowStepRunId: null,
      createdAt: '2026-10-05T00:00:00.000Z',
    };

    expect(() => validateGenerationTask(task, descriptor)).not.toThrow();
  });

  it('uses separate media ceilings and exports bounded stream and metadata limits', () => {
    expect(getGenerationMediaCeilingBytes('IMAGE', 'image/png', 'input')).toBe(128 * 1024 ** 2);
    expect(getGenerationMediaCeilingBytes('AUDIO', 'audio/wav', 'output')).toBe(1024 ** 3);
    expect(getGenerationMediaCeilingBytes('VIDEO', 'video/mp4', 'output')).toBe(4 * 1024 ** 3);
    expect(getGenerationMediaCeilingBytes('IMAGE', 'video/mp4', 'input')).toBeNull();
    expect(GENERATION_MEDIA_POLICY.ioChunkBytes).toBe(64 * 1024);
    expect(GENERATION_MEDIA_POLICY.maxSourceChunkBytes).toBe(1024 * 1024);
    expect(GENERATION_MEDIA_POLICY.maxMetadataBytes).toBe(8 * 1024 ** 2);
    expect(generationMetadataSizeBytes({ title: '视频' })).toBeGreaterThan(0);
  });
});
