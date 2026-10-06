import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@cultivation/application/r0-decision';
import type { ModelGateway, ModelRequest } from '@cultivation/application';
import { SkillRoutingFixtureObserver } from './r5-1-fixture-observer.js';

function observerFile(): string {
  const base = join(process.cwd(), '.test-data');
  mkdirSync(base, { recursive: true });
  return join(mkdtempSync(join(base, 'r51-observer-')), 'facts.json');
}

describe('explicit R5.1 fixture observations', () => {
  it('persists hashes and context shape without the task or metadata display text', async () => {
    const file = observerFile();
    const observer = new SkillRoutingFixtureObserver(file);
    const response = {
      answers: { skills: [{ skillId: 'skill-1', score: 1 }] },
      confidence: {},
      selectedAction: null,
    };
    const request = {
      decisionType: 'SKILL_RELEVANCE',
      questionVersion: 'v1',
      policyVersion: 'p1',
      stateHash: 'hash',
      questions: {},
      inputSummary: { taskSummary: 'PRIVATE_TASK', candidateIds: ['skill-1'] },
      state: {
        candidates: [{ id: 'skill-1', name: 'Private display', description: '', tags: [] }],
        context: {
          objective: 'PRIVATE_TASK',
          stepType: 'REVIEW',
          inputArtifactSummaries: [
            { id: 'artifact-1', kind: 'JSON', name: 'PRIVATE_ARTIFACT_NAME' },
          ],
          expectedOutputContract: [
            {
              key: 'PRIVATE_OUTPUT_NAME',
              kind: 'JSON',
              contractId: 'PRIVATE_CONTRACT',
              contractVersion: '1',
            },
          ],
        },
      },
    } as DecisionRequest;
    expect(
      await observer.decisionGateway({ evaluate: async () => response }).evaluate(request),
    ).toBe(response);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/PRIVATE_|Private display/);
    const fact = JSON.parse(text).decisions[0];
    expect(fact.contextFacts.objectiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fact.contextFacts.stepType).toBe('REVIEW');
    expect(fact.contextFacts.inputArtifactSummaries[0].fields).toEqual(['id', 'kind', 'name']);
    expect(fact.context).toBeUndefined();
  });

  it('observes actual selected IDs without persisting or changing the LANGUAGE transcript', async () => {
    const file = observerFile();
    const observer = new SkillRoutingFixtureObserver(file, () => ({
      missionId: 'mission',
      runId: 'run',
      selectionHash: 'hash',
    }));
    const request = {
      teammateId: 'a',
      runtimeProfileId: 'runtime-a',
      participantOutcomeContract: 'g3-v1',
      tools: [],
      messages: [
        {
          role: 'system',
          content:
            '[ACTIVE SKILLS — DECLARATIVE GUIDANCE DATA]\n' +
            JSON.stringify([{ id: 'skill-1', text: 'PRIVATE_SKILL_INSTRUCTIONS' }]),
        },
      ],
    } as ModelRequest & { tools: [] };
    const result = { text: 'Result', usage: { inputTokens: 1, outputTokens: 2 } };
    let received: unknown;
    const gateway = observer.modelGateway({
      generateWithTools: async (input: unknown) => {
        received = input;
        return result;
      },
    } as unknown as ModelGateway);
    expect(await gateway.generateWithTools!(request)).toBe(result);
    expect(received).toBe(request);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('PRIVATE_SKILL_INSTRUCTIONS');
    const fact = JSON.parse(text).modelCalls[0];
    expect(fact.selectedSkillIds).toEqual(['skill-1']);
    expect(fact.structuredOutcomeContract).toBe('g3-v1');
    expect(fact.missionId).toBe('mission');
    expect(fact.messages).toBeUndefined();
  });
});
