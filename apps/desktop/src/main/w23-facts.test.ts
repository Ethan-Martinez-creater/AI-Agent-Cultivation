import { describe, expect, it } from 'vitest';
import { researchIntegrityFacts } from './w23-facts.js';

function fixture() {
  const hash = 'a'.repeat(64);
  const step = {
    id: 'attempt-one',
    stepId: 'R08',
    missionId: 'mission',
    missionRunId: 'old',
    attempt: 1,
    state: 'FAILED',
  };
  const detail = {
    run: { id: 'workflow' },
    version: { definition: { id: 'official.research' } },
    steps: [step],
    events: [],
  };
  const runs = [
    { id: 'old', status: 'INTERRUPTED', errorCode: 'RESTART' },
    { id: 'fresh', status: 'RUNNING', errorCode: null },
  ];
  const events = [
    { runId: 'old', eventType: 'model.call_started', payloadJson: {} },
    {
      runId: 'old',
      eventType: 'tool.result',
      payloadJson: {
        success: true,
        source: 'MCP',
        capability: 'MCP_TOOL_EXECUTE',
        artifactFiles: [
          { path: 'workflows/workflow/attempt-one/raw-result.json', contentHash: hash },
        ],
      },
    },
    {
      runId: 'another-run',
      eventType: 'tool.result',
      payloadJson: {
        success: true,
        source: 'MCP',
        capability: 'MCP_TOOL_EXECUTE',
        artifactFiles: [{ path: 'workflows/workflow/attempt-one/foreign.json', contentHash: hash }],
      },
    },
  ];
  const requests: { state: string }[] = [];
  const facts = researchIntegrityFacts(
    { detail: () => detail, listRuns: () => [{ id: 'workflow' }] } as never,
    { listRuns: () => runs, listMissionEvents: () => events } as never,
    {} as never,
    { listExternalWorkRequests: () => requests } as never,
  );
  return { facts, detail, events, runs, hash, requests };
}

describe('research failure history comes from actual terminal executions', () => {
  it('retains interrupted attempts and their real files without borrowing fresh Run facts', () => {
    const f = fixture();
    const rows = f.facts.listFailedExperimentAttemptsForRun!('workflow');
    expect(rows).toEqual([
      {
        workflowRunId: 'workflow',
        stepRunId: 'attempt-one',
        missionId: 'mission',
        missionRunId: 'old',
        attempt: 1,
        outcome: 'INTERRUPTED',
        errorCode: 'RESTART',
        rawPaths: ['workflows/workflow/attempt-one/raw-result.json'],
        rawHashes: [f.hash],
      },
    ]);
    expect(f.facts.listFailedExperimentAttemptsForRun!('workflow')).toEqual(rows);
  });
  it('does not invent failed experiment evidence for an unexecuted attempt', () => {
    const f = fixture();
    f.events.length = 0;
    expect(f.facts.listFailedExperimentAttemptsForRun!('workflow')).toEqual([]);
  });
  it('does not mislabel a rejected unexecuted handoff as an experiment', () => {
    const f = fixture();
    f.events.length = 0;
    f.events.push({ runId: 'old', eventType: 'external_work.created', payloadJson: {} });
    f.requests.push({ state: 'REJECTED' });
    expect(f.facts.listFailedExperimentAttemptsForRun!('workflow')).toEqual([]);
  });
  it('retains failed Artifact validation without pretending a Mission failed', () => {
    const f = fixture();
    f.runs[0]!.status = 'COMPLETED';
    f.detail.events.push({ stepRunId: 'attempt-one', type: 'step.validation_failed' } as never);
    const rows = f.facts.listFailedExperimentAttemptsForRun!('workflow');
    expect(rows[0]?.outcome).toBe('FAILED');
    expect(f.runs[0]?.status).toBe('COMPLETED');
  });
});
