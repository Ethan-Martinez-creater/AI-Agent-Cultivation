import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  MissionEvent,
  StepOperationReceipt,
  WorkflowStepDefinition,
} from '@cultivation/domain';
import type { WorkflowMissionSnapshot } from '@cultivation/application';
import { WorkflowWorkspaceValidation } from './w2-workspace-validation.js';

const at = '2026-10-01T00:00:00.000Z';
function setup() {
  const root = join(process.cwd(), '.test-data', `w2-validation-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'result.txt'), 'actual persisted result', 'utf8');
  const rootTag = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
  const events = [
    {
      id: 'event',
      missionId: 'mission',
      runId: 'mission-run',
      eventType: 'tool.result',
      actorId: 'actual-member',
      actorType: 'TEAMMATE',
      createdAt: at,
      payloadJson: {
        success: true,
        capability: 'FILE_WRITE',
        resource: `file:${rootTag}:result.txt`,
      },
    },
  ] as MissionEvent[];
  const adapter = new WorkflowWorkspaceValidation({ listMissionEvents: () => events }, () => root);
  const step: WorkflowStepDefinition = {
    id: 'step',
    type: 'TASK',
    title: 'Step',
    objective: 'Produce file',
    routing: {},
    inputs: [],
    outputs: [
      {
        key: 'result.txt',
        kind: 'FILE',
        required: true,
        contractId: 'test.file',
        contractVersion: '1',
        maxSizeBytes: 10000,
        description: 'File',
        validator: { type: 'METADATA', allowedExtensions: ['.txt'] },
      },
    ],
    maxAttempts: 3,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'FILE_OUTPUT',
    effectPaths: ['result.txt'],
  };
  const snapshot = {
    mission: { id: 'mission', state: 'COMPLETED', coordinatorTeammateId: 'coordinator' },
    run: { id: 'mission-run', status: 'COMPLETED' },
    outputs: [],
    uncertainSideEffects: false,
  } as unknown as WorkflowMissionSnapshot;
  const receipt: StepOperationReceipt = {
    id: 'operation',
    workflowRunId: 'workflow',
    stepRunId: 'step-run',
    attempt: 1,
    operationKey: 'stable-key',
    effectType: 'FILE_OUTPUT',
    state: 'PREPARED',
    inputHash: 'a'.repeat(64),
    manifest: [{ relativePath: 'result.txt' }],
    createdAt: at,
    updatedAt: at,
  };
  return { root, events, adapter, step, snapshot, receipt };
}
describe('W2 canonical workspace verification', () => {
  it('captures actual before hash and verifies exact resource without executing a tool', async () => {
    const f = setup();
    const before = await f.adapter.capture(f.step, f.root);
    expect(before?.[0]?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    const applied = await f.adapter.verify(f.receipt, f.step, f.snapshot, f.root);
    expect(applied.verified).toBe(true);
    expect(applied.manifest?.[0]?.afterHash).toBe(before?.[0]?.beforeHash);
  });
  it('rejects wrong Run evidence and path-resource mismatch', async () => {
    const f = setup();
    f.events[0]!.runId = 'other-run';
    expect((await f.adapter.verify(f.receipt, f.step, f.snapshot, f.root)).verified).toBe(false);
    f.events[0]!.runId = 'mission-run';
    f.events[0]!.payloadJson.resource = 'file:other-root:result.txt';
    expect((await f.adapter.verify(f.receipt, f.step, f.snapshot, f.root)).verified).toBe(false);
  });
  it('APPLIED recovery verifies saved after hash rather than accepting changed output', async () => {
    const f = setup();
    const initial = await f.adapter.verify(f.receipt, f.step, f.snapshot, f.root);
    const applied = { ...f.receipt, state: 'APPLIED' as const, manifest: initial.manifest };
    expect((await f.adapter.verify(applied, f.step, f.snapshot, f.root)).verified).toBe(true);
    writeFileSync(join(f.root, 'result.txt'), 'changed after crash', 'utf8');
    expect((await f.adapter.verify(applied, f.step, f.snapshot, f.root)).verified).toBe(false);
  });
  it('keeps actual Tool actor/event on collected FILE output', async () => {
    const f = setup();
    const result = await f.adapter.collect(f.snapshot, f.step, f.root);
    expect(result.outputs[0]).toMatchObject({
      source: 'MISSION',
      sourceId: 'event',
      actorId: 'actual-member',
      kind: 'FILE',
      content: '',
      metadata: { evidenceEventId: 'event' },
    });
  });
  it('keeps per-file actor provenance in a bounded directory manifest', async () => {
    const f = setup();
    const definition = {
      ...f.step,
      outputs: [{ ...f.step.outputs[0]!, kind: 'DIRECTORY' as const }],
    };
    const result = await f.adapter.collect(f.snapshot, definition, f.root);
    const manifest = result.outputs.find((o) => o.kind === 'DIRECTORY')!;
    expect(JSON.parse(manifest.content).entries).toHaveLength(1);
    expect(JSON.parse(String(manifest.metadata.executionEvidence))).toEqual([
      {
        relativePath: 'result.txt',
        source: 'MISSION',
        sourceId: 'event',
        actorId: 'actual-member',
      },
    ]);
  });
  it('denial and model claims do not prove a file effect', async () => {
    const f = setup();
    f.events[0]!.payloadJson.success = false;
    expect((await f.adapter.verify(f.receipt, f.step, f.snapshot, f.root)).verified).toBe(false);
    expect((await f.adapter.collect(f.snapshot, f.step, f.root)).outputs).toEqual([]);
  });
  it('refuses changed Workspace and traversal declarations', async () => {
    const f = setup();
    await expect(f.adapter.capture(f.step, 'elsewhere')).rejects.toThrow();
    await expect(
      f.adapter.capture({ ...f.step, effectPaths: ['../escape.txt'] }, f.root),
    ).rejects.toThrow();
  });
});
