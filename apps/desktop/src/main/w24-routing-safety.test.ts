import { describe, expect, it } from 'vitest';
import type {
  CapabilityDimension,
  PermissionRule,
  ToolDescriptor,
  WorkflowDetail,
  WorkflowStepRun,
  WorkflowVersion,
} from '@cultivation/domain';
import { OFFICIAL_BUILTIN_WORKFLOW_PACKAGES } from './w2-builtin-installation.js';
import { WorkflowMissionAdapter } from './w1-mission-adapter.js';
import {
  makeHarness,
  teammate,
  humanBridge,
} from '../../../../packages/application/src/testing/r4-routing-harness.js';
import { ToolRegistry, ToolRuntime } from '../../../../packages/application/src/tool-runtime.js';
import { PermissionEngine } from '../../../../packages/application/src/permission-engine.js';

const versions = OFFICIAL_BUILTIN_WORKFLOW_PACKAGES.map((item) => item.version);
function execution(version: WorkflowVersion, stepId = version.entryStepId) {
  const at = '2026-10-04T00:00:00.000Z';
  const runId = `w24-${version.definition.id}`;
  const step: WorkflowStepRun = {
    id: `${runId}-${stepId}`,
    workflowRunId: runId,
    stepId,
    attempt: 1,
    state: 'READY',
    missionId: null,
    missionRunId: null,
    waitReason: null,
    errorCode: null,
    createdAt: at,
    updatedAt: at,
  };
  const detail: WorkflowDetail = {
    version,
    run: {
      id: runId,
      definitionId: version.definition.id,
      definitionVersion: 1,
      inputSnapshot: {},
      state: 'READY',
      waitReason: null,
      createdAt: at,
      updatedAt: at,
    },
    steps: [step],
    artifacts: [],
    bindings: [],
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
  };
  const definition = version.steps.find((item) => item.id === stepId)!;
  return { detail, step, definition };
}
const scores = (dimensions: CapabilityDimension[], score: number) =>
  Object.fromEntries(dimensions.map((dimension) => [dimension, score]));
describe('W2.4 all OFFICIAL workflows reuse controlled R4 and Permission', () => {
  it.each(versions)(
    '$definition.id probes ranked candidates sequentially and records the actual selected identity',
    async (version) => {
      const f = execution(version);
      const capabilities = f.definition.routing.requiredCapabilities!;
      const h = makeHarness({
        teammates: [teammate('preferred'), teammate('next'), humanBridge()],
        scores: { preferred: scores(capabilities, 95), next: scores(capabilities, 80) },
        probes: { preferred: { ok: false, status: 'UNAVAILABLE' } },
        humanBridgeSupports: true,
      });
      const result = await h.planner.plan({
        ...f.definition.routing,
        executionConstraint: 'AUTO',
        objective: f.definition.objective,
        executionContext: {
          origin: 'WORKFLOW',
          executionId: f.detail.run.id,
          stepId: f.step.id,
          stepType: f.definition.type,
        },
      });
      expect(result.status).toBe('ASSIGNED');
      expect(result.receipt.assignment?.coordinatorTeammateId).toBe('next');
      expect(h.probeOrder).toEqual(['preferred', 'next']);
      expect(h.maxConcurrentProbes).toBe(1);
    },
  );
  it.each(versions)(
    '$definition.id AUTO all unavailable uses real Human Bridge, capability conflict performs zero probes',
    async (version) => {
      const f = execution(version);
      const dimensions = f.definition.routing.requiredCapabilities!;
      const h = makeHarness({
        teammates: [teammate('model'), humanBridge()],
        scores: { model: scores(dimensions, 90) },
        probes: { model: { ok: false, status: 'UNAVAILABLE' } },
        humanBridgeSupports: true,
      });
      const result = await h.planner.plan({
        objective: f.definition.objective,
        requiredCapabilities: dimensions,
        executionConstraint: 'AUTO',
      });
      expect(result.status).toBe('ASSIGNED');
      expect(result.receipt.assignment?.kind).toBe('HUMAN_BRIDGE');
      expect(h.probeOrder).toEqual(['model']);
      const conflict = makeHarness({ teammates: [teammate('model')], scores: { model: {} } });
      expect(
        (
          await conflict.planner.plan({
            objective: f.definition.objective,
            requiredCapabilities: dimensions,
            executionConstraint: 'SOLO',
          })
        ).status,
      ).toBe('USER_ACTION_REQUIRED');
      expect(conflict.probeOrder).toEqual([]);
    },
  );
  it.each(versions)(
    '$definition.id purpose metadata never grants Tool authority across Missions',
    async (version) => {
      let executions = 0;
      const registry = new ToolRegistry();
      const descriptor: ToolDescriptor = {
        id: 'mcp:local:work',
        name: '本地操作',
        description: '',
        source: 'MCP',
        capability: 'MCP_TOOL_EXECUTE',
        workflowPurposes: ['RESEARCH', 'VOICEOVER', 'VIDEO_ASSEMBLY'],
        riskLevel: 'HIGH',
        sideEffect: 'EXTERNAL_WRITE',
        inputSchema: { type: 'object', additionalProperties: false },
      };
      registry.register({
        descriptor,
        resource: () => 'mcp:local:work',
        execute: async () => {
          executions++;
          return { content: '完成' };
        },
      });
      const rules: PermissionRule[] = [];
      const runtime = new ToolRuntime(
        registry,
        new PermissionEngine({
          listPermissionRules: () => rules,
          savePermissionRule: (rule) => {
            rules.push(rule);
          },
        }),
      );
      const call = { id: 'call', toolId: descriptor.id, input: {} };
      const context = {
        missionId: `${version.definition.id}-a`,
        runId: 'run-a',
        teammateId: 'actor',
      };
      expect((await runtime.dispatch(call, context)).kind).toBe('APPROVAL');
      expect(executions).toBe(0);
      rules.push({
        id: 'grant',
        subjectType: 'TEAMMATE',
        subjectId: 'actor',
        capability: descriptor.capability,
        resourcePattern: 'mcp:local:work',
        decision: 'ALLOW',
        scope: 'MISSION',
        scopeId: context.missionId,
      } as PermissionRule);
      expect((await runtime.dispatch(call, context)).kind).toBe('RESULT');
      expect(
        (
          await runtime.dispatch(call, {
            ...context,
            missionId: `${version.definition.id}-b`,
            runId: 'run-b',
          })
        ).kind,
      ).toBe('APPROVAL');
      rules.push({ ...rules[0]!, id: 'deny', decision: 'DENY' });
      const denied = await runtime.dispatch(call, context, true);
      expect(denied.kind === 'RESULT' && denied.result.code).toBe('PERMISSION_DENIED');
      expect(executions).toBe(1);
    },
  );
  it('preserves strict software review and honest sole-author research review rules', async () => {
    for (const [id, review, author] of [
      ['official.software-feature', 'S08', 'S05'],
      ['official.research', 'R06', 'R05'],
    ] as const) {
      const version = versions.find((version) => version.definition.id === id)!;
      const f = execution(version, review);
      f.detail.run.inputSnapshot = {
        workspaceRoot: 'E:/workspace',
        targetArea: ['src'],
        allowedToolScope: ['file.writeText'],
      };
      f.detail.steps.unshift({
        ...f.step,
        id: 'author-step',
        stepId: author,
        state: 'COMPLETED',
        missionId: 'author-mission',
        missionRunId: 'author-run',
      });
      const adapter = new WorkflowMissionAdapter(
        {} as never,
        {
          getMission: () => ({ coordinatorTeammateId: 'author' }),
          listMissionEvents: () => [
            {
              actorId: 'author',
              actorType: 'TEAMMATE',
              runId: 'author-run',
              eventType: 'model.call_started',
            },
          ],
        } as never,
        {} as never,
        {} as never,
        {} as never,
        () => 'E:/workspace',
        { detail: () => f.detail } as never,
        () => [],
        undefined,
        () => ['author'],
      );
      const prepared = await adapter.prepareExecution(f.definition, f.detail, f.step);
      if (id === 'official.software-feature')
        expect(prepared.routing?.excludedTeammateIds).toEqual(['author']);
      else expect(prepared.routing?.excludedTeammateIds).toBeUndefined();
      expect(version.releaseMetadata!.manifestHash).toBe(
        f.detail.version.releaseMetadata!.manifestHash,
      );
    }
  });
});
