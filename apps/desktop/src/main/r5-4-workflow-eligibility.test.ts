import { describe, expect, it, vi } from 'vitest';
import type { ToolDescriptor } from '@cultivation/domain';
import { WorkflowToolGuard } from './w22-workspace-mutations.js';

const context = { missionId: 'mission', runId: 'run', teammateId: 'actor' };
const descriptor = (
  id: string,
  source: ToolDescriptor['source'] = 'BUILTIN',
  sideEffect: ToolDescriptor['sideEffect'] = 'NONE',
): ToolDescriptor => ({
  id,
  source,
  sideEffect,
  capability:
    source === 'MCP' ? 'MCP_TOOL_EXECUTE' : sideEffect === 'NONE' ? 'FILE_READ' : 'FILE_WRITE',
  riskLevel: 'LOW',
  name: id,
  description: '',
  inputSchema: { type: 'object' },
});
function fixture(policy: string, stepId: string, operationState = 'PREPARED') {
  const step = {
    id: 'step',
    workflowRunId: 'workflow',
    stepId,
    missionId: 'mission',
    missionRunId: 'run',
    state: 'RUNNING',
    attempt: 1,
  };
  const bindMissionRun = vi.fn(() => step);
  const journal = {
    getOperation: vi.fn(() => ({
      id: 'op',
      state: operationState,
      attempt: 1,
      effectType: policy === 'research-integrity-v1' ? 'FILE_OUTPUT' : 'WORKSPACE_MUTATION',
    })),
    prepareMutation: vi.fn(),
    transitionMutation: vi.fn(),
  };
  const guard = new WorkflowToolGuard(
    {
      findStepByMissionId: () => step,
      bindMissionRun,
      detail: () => ({
        run: { id: 'workflow' },
        version: {
          definition: { source: 'BUILTIN' },
          validationPolicy: policy,
          steps: [{ id: stepId, effectType: 'WORKSPACE_MUTATION', effectPathMode: 'DYNAMIC' }],
        },
        steps: [step],
      }),
    } as never,
    journal as never,
    () => null,
    () => ({
      allowedToolIds: ['file.readText', 'file.writeText', 'mcp.verify'],
      allowedCommands: [],
      acceptanceIds: [],
      allowedPathPrefixes: [],
      planFiles: [],
    }),
  );
  const researchCheck = vi.fn();
  guard.attachResearchInputCheck(researchCheck, vi.fn());
  return { guard, journal, bindMissionRun, researchCheck };
}

describe('Main trusted descriptor eligibility', () => {
  it('software accepts only frozen allowed IDs and verification MCP at S06', () => {
    const tools = [
      descriptor('file.readText'),
      descriptor('file.outside'),
      descriptor('mcp.verify', 'MCP'),
      descriptor('file.createDirectory', 'BUILTIN', 'LOCAL_WRITE'),
    ];
    expect(
      fixture('software-integrity-v1', 'S05')
        .guard.eligibleDescriptors(context, tools)
        .map((t) => t.id),
    ).toEqual(['file.readText']);
    expect(
      fixture('software-integrity-v1', 'S06')
        .guard.eligibleDescriptors(context, tools)
        .map((t) => t.id),
    ).toEqual(['file.readText', 'mcp.verify']);
  });
  it('mutation descriptor requires current PREPARED operation without creating journal rows', () => {
    const f = fixture('software-integrity-v1', 'S05');
    const tools = [descriptor('file.writeText', 'BUILTIN', 'LOCAL_WRITE')];
    expect(f.guard.eligibleDescriptors(context, tools)).toEqual(tools);
    expect(f.bindMissionRun).not.toHaveBeenCalled();
    expect(f.journal.prepareMutation).not.toHaveBeenCalled();
    for (const state of ['APPLIED', 'UNKNOWN', 'VERIFIED'])
      expect(
        fixture('software-integrity-v1', 'S05', state).guard.eligibleDescriptors(context, tools),
      ).toEqual([]);
  });
  it('research excludes unrelated purposes, other steps and non-experiment writes', () => {
    const research: ToolDescriptor = {
      ...descriptor('mcp.research', 'MCP'),
      workflowPurposes: ['RESEARCH'],
    };
    const tools = [
      descriptor('file.readText'),
      descriptor('file.writeText', 'BUILTIN', 'LOCAL_WRITE'),
      research,
      descriptor('mcp.other', 'MCP'),
    ];
    const f = fixture('research-integrity-v1', 'R02');
    expect(f.guard.eligibleDescriptors(context, tools).map((t) => t.id)).toEqual([
      'file.readText',
      'mcp.research',
    ]);
    expect(f.researchCheck).not.toHaveBeenCalled();
    expect(
      fixture('research-integrity-v1', 'R09')
        .guard.eligibleDescriptors(context, tools)
        .map((t) => t.id),
    ).toEqual(['file.readText']);
    expect(
      fixture('research-integrity-v1', 'R08', 'UNKNOWN').guard.eligibleDescriptors(context, tools),
    ).toEqual([]);
  });
  it('does not invent restrictions for policies without an existing descriptor guard', () => {
    const tools = [descriptor('mcp.other', 'MCP')];
    expect(fixture('news-integrity-v1', 'N11').guard.eligibleDescriptors(context, tools)).toEqual(
      tools,
    );
  });
});
