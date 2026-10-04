import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepOperationReceipt } from '@cultivation/domain';
import { researchMixedExperimentBoundary } from './w23-mixed-experiment.js';
function fixture() {
  const root = join(process.cwd(), '.test-data', `w23-mixed-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const content = JSON.stringify({
    mode: 'MIXED',
    negativeResults: ['人工观测为阴性'],
    failureDetails: [],
    limitations: ['离线模拟'],
  });
  writeFileSync(join(root, 'accepted.json'), content, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  const step = {
    id: 'step',
    stepId: 'R08',
    workflowRunId: 'workflow',
    missionId: 'mission',
    missionRunId: 'run',
    attempt: 1,
    workspaceRoot: root,
  };
  const detail = {
    run: {
      id: 'workflow',
      definitionId: 'official.research',
      definitionVersion: 1,
      inputSnapshot: { experimentMode: 'MIXED' },
    },
    version: {
      definition: { id: 'official.research', source: 'BUILTIN' },
      version: 1,
      steps: [
        {
          id: 'R08',
          title: '实验',
          objective: '有界实验',
          routing: { requiredCapabilities: ['GENERAL_REASONING'] },
          workflowInputKeys: [],
          outputs: [
            {
              key: 'research.experiment_record',
              kind: 'JSON',
              required: true,
              maxSizeBytes: 100000,
              contractId: 'record',
              contractVersion: '1',
              validator: { type: 'JSON', requiredKeys: ['mode'] },
            },
          ],
          artifactPathScope: 'RUN_ATTEMPT',
          effectType: 'FILE_OUTPUT',
          effectPaths: ['research/raw-result.json', 'research/experiment-log.txt'],
        },
      ],
      contractManifest: [],
    },
    steps: [step],
    bindings: [],
    artifacts: [],
  };
  const workflows = {
    findStepByMissionId: () => step,
    detail: () => detail,
    transaction: <T>(work: () => T) => work(),
  };
  const marker = {
    runId: 'run',
    eventType: 'workflow.verification.manual_requested',
    payloadJson: { boundaryId: 'research-experiment-v1', stepRunId: 'step', requestId: 'request' },
  };
  const artifact = {
    id: 'accepted-artifact',
    path: 'accepted.json',
    sizeBytes: Buffer.byteLength(content),
    submittedAt: 'at',
    metadataJson: { contentHash: hash, targetArtifactId: 'research.experiment_record' },
  };
  const external = {
    getExternalWorkRequest: () => ({
      request: { id: 'request', state: 'ACCEPTED', submittedAt: 'at' },
      artifacts: [artifact],
    }),
  };
  const operations: StepOperationReceipt[] = [];
  const foundation = {
    listOperations: () => operations,
    prepareOperation: (receipt: StepOperationReceipt) => operations.push(receipt),
    transitionOperation: (receipt: StepOperationReceipt, state: string) => {
      const index = operations.findIndex((r) => r.id === receipt.id);
      if (index < 0 || operations[index]!.state !== state) return false;
      operations[index] = receipt;
      return true;
    },
  };
  const actual = {
    missionRunId: 'run',
    toolCallId: 'actual-computation',
    rawResults: [{ relativePath: 'raw.json', contentHash: 'a'.repeat(64) }],
  };
  const facts = { listExperimentFactsForStep: () => [actual], listSourceArtifactsForRun: () => [] };
  const boundary = researchMixedExperimentBoundary(
    workflows as never,
    { listMissionEvents: () => [marker] } as never,
    external as never,
    foundation as never,
    () => root,
    facts as never,
  );
  return { root, content, step, detail, artifact, operations, boundary, facts };
}
describe('research bounded mixed continuation', () => {
  it('prepares a separate stable external receipt and never creates a second computational operation', () => {
    const { boundary, operations } = fixture();
    expect(
      boundary
        .prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never)
        ?.draft.targetArtifacts.map((a) => a.id),
    ).toEqual(['research.experiment_record']);
    boundary.prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      effectType: 'EXTERNAL_ACTION',
      state: 'PREPARED',
      operationKey: 'workflow:workflow:step:external',
    });
  });
  it('restart composition rechecks accepted bytes, verifies once, and preserves negative observations', async () => {
    const { boundary, operations } = fixture();
    boundary.prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never);
    const continuation = { missionId: 'mission', runId: 'run', requestId: 'request' } as never;
    const first = await boundary.compose(continuation);
    const second = await boundary.compose(continuation);
    expect(first).toBe(second);
    expect(JSON.parse(first).outputs['research.experiment_record'].negativeResults).toEqual([
      '人工观测为阴性',
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.state).toBe('VERIFIED');
    expect(operations[0]!.externalReference).toBe('request');
  });
  it('rejects changed accepted artifacts without consuming or pretending external success', async () => {
    const { boundary, operations, root } = fixture();
    boundary.prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never);
    writeFileSync(join(root, 'accepted.json'), 'tampered', 'utf8');
    await expect(
      boundary.compose({ missionId: 'mission', runId: 'run', requestId: 'request' } as never),
    ).rejects.toThrow();
    expect(operations[0]!.state).toBe('PREPARED');
  });
  it('does not substitute manual acceptance for missing computational evidence', () => {
    const { boundary, facts } = fixture();
    facts.listExperimentFactsForStep = () => [];
    expect(() =>
      boundary.prepare({ id: 'mission', mode: 'SOLO' } as never, { id: 'run' } as never),
    ).toThrow();
  });
});
