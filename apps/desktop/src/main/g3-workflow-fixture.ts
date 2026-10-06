import type { WorkflowService } from '@cultivation/application';
import type { WorkflowVersion } from '@cultivation/domain';

/** Explicit offline acceptance only. Production bootstrap never publishes this fixture. */
export function registerG3WorkflowFixture(service: WorkflowService, testMode: boolean): void {
  if (!testMode) throw new Error('G3 Workflow fixture requires explicit test mode');
  const output = {
    key: 'media',
    kind: 'JSON' as const,
    required: true,
    contractId: 'test.g3-media-ref',
    contractVersion: '1',
    maxSizeBytes: 16_384,
    description: '媒体成果',
    validator: { type: 'JSON' as const, requiredKeys: ['type', 'artifact'] },
  };
  const version: WorkflowVersion = {
    definition: {
      id: 'test.g3-generation',
      name: '媒体交付验收',
      source: 'USER',
      category: 'TEST_ONLY',
      description: '仅供离线验收',
    },
    version: 1,
    entryStepId: 'generate',
    steps: [
      {
        id: 'generate',
        title: '生成素材',
        type: 'TASK',
        objective: '生成一张用于本次交付的图片',
        routing: {
          executionConstraint: 'SOLO',
          requiredExecutionProtocol: 'GENERATION',
          requiredCapabilities: ['IMAGE_GENERATION'],
        },
        inputs: [],
        outputs: [output],
        exitCondition: 'VALID_OUTPUTS',
        maxAttempts: 1,
        effectType: 'NONE',
        executionRequirements: {
          generation: {
            capability: 'IMAGE_GENERATION',
            requiredFeatures: ['TEXT_TO_IMAGE'],
            parameters: {},
            expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
            outputDestination: { scope: 'APP_ARTIFACT_STORE' },
          },
        },
      },
    ],
    edges: [],
    outputSchema: { outputs: [{ ...output, fromStepId: 'generate', outputKey: 'media' }] },
    referenceBasis: [],
    createdAt: '2026-10-06T00:00:00.000Z',
  };
  service.publish(version);
}
