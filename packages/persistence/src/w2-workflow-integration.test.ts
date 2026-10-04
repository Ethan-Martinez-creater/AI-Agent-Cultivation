import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ArtifactContract, WorkflowArtifactSpec, WorkflowVersion } from '@cultivation/domain';
import { WorkflowService } from '../../application/src/w1-workflow-service.js';
import {
  createW1FixtureTextSpec,
  createW2FixtureArtifactSpec,
  createW2FixtureClock,
  createW2FixtureContract,
  createW2FixtureMissionPort,
  createW2FixtureStep,
  createW2FixtureVersion,
} from '../../application/src/testing/w2-workflow-harness.js';
import type {
  W2FixtureMissionOptions,
  W2FixtureMissionPort,
  W2FixtureMissionRequest,
  W2FixtureMissionResult,
  W2FixtureOutputFactoryInput,
} from '../../application/src/testing/w2-workflow-harness.js';
import { migrations, runMigrations, W1WorkflowRepository, W2WorkflowRepository } from './index.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeReviewVersion(
  definitionId: string,
  contract: ArtifactContract,
  maxTotalTraversals = 2,
): WorkflowVersion {
  const output: WorkflowArtifactSpec = createW2FixtureArtifactSpec(contract);
  return createW2FixtureVersion({
    definitionId,
    version: 1,
    contracts: [contract],
    revisionGroups: [{ id: 'review-loop', maxTotalTraversals, onExhausted: 'WAITING_USER' }],
    steps: [
      createW2FixtureStep('draft', { outputs: [output] }),
      createW2FixtureStep('review', {
        type: 'REVIEW',
        inputs: [{ key: 'draft', fromStepId: 'draft', outputKey: output.key, required: true }],
        outputs: [output],
      }),
      createW2FixtureStep('polish', { outputs: [output] }),
    ],
    edges: [
      {
        id: 'draft-review',
        fromStepId: 'draft',
        toStepId: 'review',
        branch: 'next',
        condition: { type: 'ALWAYS' },
      },
      {
        id: 'review-revise-draft',
        fromStepId: 'review',
        toStepId: 'draft',
        branch: 'revise-draft',
        condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
        revisionCode: 'revise-draft',
        revision: { groupId: 'review-loop', maxTraversals: 2 },
      },
      {
        id: 'review-revise-polish',
        fromStepId: 'review',
        toStepId: 'polish',
        branch: 'revise-polish',
        condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
        revisionCode: 'revise-polish',
        revision: { groupId: 'review-loop', maxTraversals: 2 },
      },
      {
        id: 'review-pass-end',
        fromStepId: 'review',
        toStepId: null,
        branch: 'pass',
        condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
      },
      {
        id: 'polish-review',
        fromStepId: 'polish',
        toStepId: 'review',
        branch: 'review-again',
        condition: { type: 'ALWAYS' },
      },
    ],
  });
}

function jsonResult(value: unknown): W2FixtureMissionResult {
  const content = JSON.stringify(value);
  return { resultText: content, outputs: [{ kind: 'TEXT', content }] };
}

function reviewResult(reviewedArtifactIds: string[], revisionCode: string): W2FixtureMissionResult {
  return jsonResult({
    verdict: 'REVISE',
    findings: ['TEST_ONLY finding'],
    evidence: ['TEST_ONLY evidence'],
    summary: 'TEST_ONLY review',
    reviewedArtifactIds,
    revisionCode,
  });
}

function inputArtifactIds(request: W2FixtureMissionRequest): string[] {
  const metadata = request.context.inputArtifactMetadata ?? [];
  return metadata.map((item) => item.id);
}

function reviewFixtureOutput(
  revisionCode: (reviewCount: number) => string,
): (input: W2FixtureOutputFactoryInput) => W2FixtureMissionResult {
  let reviewCount = 0;
  return (input: W2FixtureOutputFactoryInput) => {
    if (input.step.id === 'review') {
      reviewCount += 1;
      return reviewResult(inputArtifactIds(input.request), revisionCode(reviewCount));
    }
    if (input.step.id === 'draft') return jsonResult({ message: 'TEST_ONLY draft' });
    return jsonResult({ message: 'TEST_ONLY rewrite' });
  };
}

function makeService(options: {
  db: Database.Database;
  version: WorkflowVersion;
  idPrefix: string;
  startMode?: 'COMPLETE' | 'WAIT_EXTERNAL';
  outputForStep?: W2FixtureMissionOptions['outputForStep'];
  missions?: W2FixtureMissionPort;
  verifyOperation?: W2FixtureMissionOptions['verifyOperation'];
  captureOperation?: W2FixtureMissionOptions['captureOperation'];
}): {
  store: W1WorkflowRepository;
  foundation: W2WorkflowRepository;
  missions: W2FixtureMissionPort;
  service: WorkflowService;
  clock: ReturnType<typeof createW2FixtureClock>;
} {
  const store = new W1WorkflowRepository(options.db);
  const foundation = new W2WorkflowRepository(options.db);
  const clock = createW2FixtureClock(options.idPrefix);
  const missions =
    options.missions ??
    createW2FixtureMissionPort({
      db: options.db,
      store,
      version: options.version,
      missionIdPrefix: options.idPrefix,
      startMode: options.startMode,
      outputForStep: options.outputForStep,
      verifyOperation: options.verifyOperation,
      captureOperation: options.captureOperation,
    });
  return {
    store,
    foundation,
    missions,
    service: new WorkflowService(store, missions, clock, foundation),
    clock,
  };
}

describe('W2 Workflow real SQLite/application integration', () => {
  it('freezes each Contract version and keeps an existing Run pinned to its old version', () => {
    const db = database();
    try {
      const firstContract = createW2FixtureContract('1');
      const firstVersion = createW2FixtureVersion({
        definitionId: 'test-contract-freeze',
        version: 1,
        contracts: [firstContract],
        steps: [
          createW2FixtureStep('work', { outputs: [createW2FixtureArtifactSpec(firstContract)] }),
        ],
      });
      const h = makeService({ db, version: firstVersion, idPrefix: 'freeze' });
      h.service.publish(firstVersion);
      const run = h.service.createRun({ definitionId: firstVersion.definition.id, version: 1 });

      const secondContract = createW2FixtureContract('2', {
        validatorVersion: 'w2-deterministic-v1',
        maxSizeBytes: 8192,
      });
      const secondVersion = createW2FixtureVersion({
        definitionId: firstVersion.definition.id,
        version: 2,
        contracts: [secondContract],
        steps: [
          createW2FixtureStep('work', { outputs: [createW2FixtureArtifactSpec(secondContract)] }),
        ],
      });
      h.service.publish(secondVersion);

      expect(h.foundation.getContract(firstContract.contractId, '1')).toEqual(firstContract);
      expect(h.foundation.getContract(secondContract.contractId, '2')).toEqual(secondContract);
      expect(h.store.getVersion(firstVersion.definition.id, 1)).toEqual(firstVersion);
      expect(h.service.detail(run.run.id).run.definitionVersion).toBe(1);
      expect(h.service.detail(run.run.id).version.contractManifest).toEqual([firstContract]);
      expect(h.service.detail(run.run.id).version.steps[0]?.outputs[0]?.contractVersion).toBe('1');
    } finally {
      db.close();
    }
  });

  it('reuses W1 routing context through one Mission execution runtime', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = createW2FixtureVersion({
        definitionId: 'test-routing-context-reuse',
        version: 1,
        contracts: [contract],
        steps: [
          createW2FixtureStep('work', {
            routing: {
              executionConstraint: 'SOLO',
              explicitTeammateId: 'w2-test-coordinator',
            },
            outputs: [createW2FixtureArtifactSpec(contract)],
          }),
        ],
      });
      let observedContext: W2FixtureMissionRequest['context'] | undefined;
      const h = makeService({
        db,
        version,
        idPrefix: 'routing-reuse',
        outputForStep: (input) => {
          observedContext = input.request.context;
          return jsonResult({ message: 'TEST_ONLY routed output' });
        },
      });
      h.service.publish(version);
      const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });

      const completed = await h.service.advance(run.run.id);

      expect(completed.run.state).toBe('COMPLETED');
      expect(observedContext?.executionConstraint).toBe('SOLO');
      expect(observedContext?.explicitTeammateId).toBe('w2-test-coordinator');
      expect(observedContext?.executionContext).toEqual({
        origin: 'WORKFLOW',
        executionId: run.run.id,
        stepId: completed.steps[0]?.id,
        stepType: 'TASK',
      });
      expect(h.missions.calls.create).toBe(1);
      expect(h.missions.calls.start).toBe(1);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM mission_runs').get() as { count: number }).count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('shares a revision budget across REVIEW REVISE edges and does not replay a traversal after service restart', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = makeReviewVersion('test-review-budget', contract, 2);
      const outputForStep = reviewFixtureOutput((count) =>
        count === 2 ? 'revise-polish' : 'revise-draft',
      );
      const first = makeService({ db, version, idPrefix: 'revision', outputForStep });
      first.service.publish(version);
      const run = first.service.createRun({ definitionId: version.definition.id, version: 1 });

      const afterFirstPass = await first.service.advance(run.run.id);
      expect(afterFirstPass.traversals).toHaveLength(1);
      expect(afterFirstPass.traversals?.[0]?.edgeId).toBe('review-revise-draft');
      expect(afterFirstPass.traversals?.[0]?.groupId).toBe('review-loop');

      const restarted = makeService({
        db,
        version,
        idPrefix: 'revision-restarted',
        outputForStep,
        missions: first.missions,
      });
      await restarted.service.recover();
      expect(restarted.service.detail(run.run.id).traversals).toHaveLength(1);

      const afterSecondReview = await restarted.service.advance(run.run.id);
      expect(afterSecondReview.run.state).toBe('WAITING');
      expect(afterSecondReview.run.waitReason).toBe('USER_CONFIRMATION');
      expect(
        afterSecondReview.steps.find((step) => step.stepId === 'review' && step.attempt === 3)
          ?.errorCode,
      ).toBe('REVISION_BUDGET_EXHAUSTED');
      expect(afterSecondReview.traversals).toHaveLength(2);
      expect(
        afterSecondReview.decisions.filter((decision) =>
          decision.edgeId.startsWith('review-revise-'),
        ),
      ).toHaveLength(2);
      await restarted.service.recover();
      expect(restarted.service.detail(run.run.id).traversals).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('rejects a REVIEW revisionCode that is not declared by either edge', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = makeReviewVersion('test-undeclared-revision-code', contract, 2);
      const outputForStep = reviewFixtureOutput(() => 'not-declared');
      const h = makeService({ db, version, idPrefix: 'undeclared', outputForStep });
      h.service.publish(version);
      const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });

      const detail = await h.service.advance(run.run.id);
      const review = detail.steps.find((step) => step.stepId === 'review' && step.attempt === 1);
      expect(review?.state).toBe('WAITING');
      expect(review?.errorCode).toBe('UNDECLARED_REVISION_CODE');
      expect(detail.decisions.some((decision) => decision.stepRunId === review?.id)).toBe(false);
      expect(detail.traversals).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rolls back a revision decision and traversal on checkpoint failure, then commits once during recovery', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = makeReviewVersion('test-checkpoint-recovery', contract, 2);
      const h = makeService({
        db,
        version,
        idPrefix: 'checkpoint',
        startMode: 'WAIT_EXTERNAL',
      });
      h.service.publish(version);
      const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });
      await h.service.advance(run.run.id);

      const draftMissionId = h.missions.missionIdForStep(run.run.id, 'draft');
      expect(draftMissionId).not.toBeNull();
      h.missions.completeMission(draftMissionId!, jsonResult({ message: 'TEST_ONLY draft' }));
      await h.service.recover();

      await h.service.advance(run.run.id);
      const reviewMissionId = h.missions.missionIdForStep(run.run.id, 'review');
      expect(reviewMissionId).not.toBeNull();
      const beforeReview = h.service.detail(run.run.id);
      const draftStep = beforeReview.steps.find(
        (step) => step.stepId === 'draft' && step.attempt === 1,
      )!;
      const draftArtifact = beforeReview.artifacts.find(
        (artifact) => artifact.producerStepRunId === draftStep.id,
      )!;
      h.missions.completeMission(
        reviewMissionId!,
        reviewResult([draftArtifact.id], 'revise-draft'),
      );

      const beforeFailure = h.service.detail(run.run.id);
      const originalAppendCheckpoint = h.store.appendCheckpoint.bind(h.store);
      let failCheckpoint = true;
      h.store.appendCheckpoint = (checkpoint) => {
        if (failCheckpoint) {
          failCheckpoint = false;
          throw new Error('TEST_ONLY checkpoint failure');
        }
        originalAppendCheckpoint(checkpoint);
      };
      await expect(h.service.recover()).rejects.toThrow('TEST_ONLY checkpoint failure');
      h.store.appendCheckpoint = originalAppendCheckpoint;

      const rolledBack = h.service.detail(run.run.id);
      expect(rolledBack.traversals).toHaveLength(0);
      expect(rolledBack.decisions).toHaveLength(beforeFailure.decisions.length);
      expect(rolledBack.checkpoints).toHaveLength(beforeFailure.checkpoints.length);
      expect(
        rolledBack.steps.find((step) => step.stepId === 'review' && step.attempt === 1)?.state,
      ).toBe('WAITING');

      const restarted = makeService({
        db,
        version,
        idPrefix: 'checkpoint-restarted',
        startMode: 'WAIT_EXTERNAL',
        missions: h.missions,
      });
      await restarted.service.recover();
      expect(restarted.service.detail(run.run.id).traversals).toHaveLength(1);
      expect(
        restarted.service
          .detail(run.run.id)
          .decisions.filter((decision) => decision.edgeId === 'review-revise-draft'),
      ).toHaveLength(1);
      expect(restarted.service.detail(run.run.id).checkpoints).toHaveLength(
        beforeFailure.checkpoints.length + 1,
      );
      await restarted.service.recover();
      expect(restarted.service.detail(run.run.id).traversals).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: 'FILE_OUTPUT',
      effectType: 'FILE_OUTPUT' as const,
      effectPaths: ['out/result.txt'],
      preparedManifest: [{ relativePath: 'out/result.txt' }],
      manifest: [
        {
          relativePath: 'out/result.txt',
          afterHash: createHash('sha256').update('file').digest('hex'),
        },
      ],
      output: jsonResult({ message: 'TEST_ONLY file effect result' }),
    },
    {
      name: 'WORKSPACE_MUTATION',
      effectType: 'WORKSPACE_MUTATION' as const,
      effectPaths: ['docs/README.md'],
      preparedManifest: [
        {
          relativePath: 'docs/README.md',
          beforeHash: createHash('sha256').update('before').digest('hex'),
        },
      ],
      manifest: [
        {
          relativePath: 'docs/README.md',
          beforeHash: createHash('sha256').update('before').digest('hex'),
          afterHash: createHash('sha256').update('after').digest('hex'),
        },
      ],
      output: jsonResult({ message: 'TEST_ONLY workspace effect result' }),
    },
  ])(
    'verifies terminal Mission facts for APPLIED $name receipts without start or retry',
    async (scenario) => {
      const db = database();
      try {
        const contract = createW2FixtureContract('1');
        const spec = createW2FixtureArtifactSpec(contract);
        const version = createW2FixtureVersion({
          definitionId: 'test-applied-' + scenario.name.toLowerCase(),
          version: 1,
          contracts: [contract],
          steps: [
            createW2FixtureStep('work', {
              effectType: scenario.effectType,
              effectPaths: scenario.effectPaths,
              outputs: [spec],
            }),
          ],
        });
        const h = makeService({
          db,
          version,
          idPrefix: 'applied-' + scenario.name,
          startMode: 'WAIT_EXTERNAL',
          captureOperation: async () => scenario.preparedManifest,
        });
        h.service.publish(version);
        const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });
        await h.service.advance(run.run.id);

        const missionId = h.missions.missionIdForStep(run.run.id, 'work');
        expect(missionId).not.toBeNull();
        h.missions.completeMission(missionId!, scenario.output);
        const receipt = h.foundation.listOperations(run.run.id)[0]!;
        expect(receipt.state).toBe('PREPARED');
        expect(
          h.foundation.transitionOperation(
            {
              ...receipt,
              state: 'APPLIED',
              manifest: scenario.manifest,
              updatedAt: h.clock.now(),
            },
            'PREPARED',
          ),
        ).toBe(true);
        const callsBeforeRecovery = { ...h.missions.calls };

        await h.service.recover();
        const detail = h.service.detail(run.run.id);
        const verified = detail.operations?.[0];
        expect(detail.run.state).toBe('COMPLETED');
        expect(verified?.state).toBe('VERIFIED');
        expect(verified?.outputArtifactIds).toHaveLength(1);
        expect(h.missions.calls.verifyOperation - callsBeforeRecovery.verifyOperation).toBe(2);
        expect(h.missions.calls.start).toBe(callsBeforeRecovery.start);
        expect(h.missions.calls.retry).toBe(callsBeforeRecovery.retry);
      } finally {
        db.close();
      }
    },
  );
  it('waits for user action when an EXTERNAL_ACTION receipt becomes UNKNOWN and never starts or retries it during recovery', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = createW2FixtureVersion({
        definitionId: 'test-unknown-external',
        version: 1,
        contracts: [contract],
        steps: [
          createW2FixtureStep('external', {
            effectType: 'EXTERNAL_ACTION',
            outputs: [createW2FixtureArtifactSpec(contract)],
          }),
        ],
      });
      const h = makeService({
        db,
        version,
        idPrefix: 'unknown',
        startMode: 'WAIT_EXTERNAL',
        verifyOperation: async () => ({ verified: false, manifest: [] }),
      });
      h.service.publish(version);
      const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });
      await h.service.advance(run.run.id);
      const missionId = h.missions.missionIdForStep(run.run.id, 'external');
      expect(missionId).not.toBeNull();
      h.missions.completeMission(missionId!, jsonResult({ message: 'TEST_ONLY external result' }));

      await h.service.recover();
      const waiting = h.service.detail(run.run.id);
      expect(waiting.run.state).toBe('WAITING');
      expect(waiting.run.waitReason).toBe('USER_CONFIRMATION');
      expect(waiting.operations?.[0]?.state).toBe('UNKNOWN');
      expect(waiting.operations?.[0]?.manifest).toEqual([]);
      expect(waiting.steps.find((step) => step.stepId === 'external')?.errorCode).toBe(
        'OPERATION_UNKNOWN',
      );
      const callsAtUnknown = { ...h.missions.calls };

      const restarted = makeService({
        db,
        version,
        idPrefix: 'unknown-restarted',
        startMode: 'WAIT_EXTERNAL',
        verifyOperation: async () => ({ verified: false, manifest: [] }),
      });
      await restarted.service.recover();
      expect(restarted.service.detail(run.run.id).operations?.[0]?.state).toBe('UNKNOWN');
      expect(restarted.service.detail(run.run.id).operations?.[0]?.manifest).toEqual([]);
      expect(restarted.missions.calls.start).toBe(0);
      expect(restarted.missions.calls.retry).toBe(0);
      expect(h.missions.calls.start).toBe(callsAtUnknown.start);
      expect(h.missions.calls.retry).toBe(callsAtUnknown.retry);
      expect(h.missions.calls.verifyOperation).toBe(callsAtUnknown.verifyOperation);
    } finally {
      db.close();
    }
  });

  it('stops a still-pending external Mission when its receipt is already UNKNOWN', async () => {
    const db = database();
    try {
      const contract = createW2FixtureContract('1');
      const version = createW2FixtureVersion({
        definitionId: 'test-pending-unknown-external',
        version: 1,
        contracts: [contract],
        steps: [
          createW2FixtureStep('external', {
            effectType: 'EXTERNAL_ACTION',
            outputs: [createW2FixtureArtifactSpec(contract)],
          }),
        ],
      });
      const h = makeService({
        db,
        version,
        idPrefix: 'pending-unknown',
        startMode: 'WAIT_EXTERNAL',
      });
      h.service.publish(version);
      const run = h.service.createRun({ definitionId: version.definition.id, version: 1 });
      await h.service.advance(run.run.id);
      const before = h.service.detail(run.run.id);
      const receipt = before.operations![0]!;
      expect(before.run.waitReason).toBe('EXTERNAL_WORK');
      expect(h.foundation.transitionOperation({ ...receipt, state: 'UNKNOWN' }, 'PREPARED')).toBe(
        true,
      );
      const calls = { ...h.missions.calls };
      await h.service.recover();
      const waiting = h.service.detail(run.run.id);
      expect(waiting.run.waitReason).toBe('USER_CONFIRMATION');
      expect(waiting.steps[0]?.errorCode).toBe('OPERATION_UNKNOWN');
      expect(waiting.steps[0]?.missionRunId).toBe(before.steps[0]?.missionRunId);
      expect(waiting.operations![0]?.state).toBe('UNKNOWN');
      await h.service.advance(run.run.id);
      await h.service.recover();
      expect(h.missions.calls).toEqual(calls);
      expect(h.service.detail(run.run.id).run.waitReason).toBe('USER_CONFIRMATION');
    } finally {
      db.close();
    }
  });

  it('continues to run a legacy W1 version without a W2 Contract manifest or operation receipt', async () => {
    const db = database();
    try {
      const version = createW2FixtureVersion({
        definitionId: 'legacy-w1-compatibility',
        version: 1,
        steps: [createW2FixtureStep('work', { outputs: [createW1FixtureTextSpec()] })],
      });
      const store = new W1WorkflowRepository(db);
      const clock = createW2FixtureClock('legacy');
      const missions = createW2FixtureMissionPort({
        db,
        store,
        version,
        outputForStep: () => ({
          resultText: 'Legacy W1 text result',
          outputs: [{ kind: 'TEXT', content: 'Legacy W1 text result' }],
        }),
      });
      const service = new WorkflowService(store, missions, clock);
      const foundation = new W2WorkflowRepository(db);
      service.publish(version);
      const run = service.createRun({ definitionId: version.definition.id, version: 1 });

      const completed = await service.advance(run.run.id);
      expect(completed.run.state).toBe('COMPLETED');
      expect(completed.version.contractManifest).toBeUndefined();
      expect(foundation.listOperations(run.run.id)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
