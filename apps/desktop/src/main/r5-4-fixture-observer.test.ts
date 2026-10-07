import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelGateway } from '@cultivation/application';
import type { DecisionRequest } from '@cultivation/application/r0-decision';
import { ToolShortlistFixtureObserver } from './r5-4-fixture-observer.js';

function fixture() {
  const directory = join(process.cwd(), '.test-data', `r54-observer-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'facts.json');
  return { file, observer: new ToolShortlistFixtureObserver(file, () => []) };
}

it('records only offered/proposed IDs and retains observations on fixture restart', async () => {
  const { file, observer } = fixture();
  const gateway = observer.modelGateway(new FakeModelGateway()) as ModelGateway;
  await gateway.generateWithTools!({
    teammateId: 'a',
    runtimeProfileId: 'runtime-a',
    messages: [{ role: 'user', content: '__R54_READ__ PRIVATE_BODY_SENTINEL' }],
    tools: [],
  });
  const facts = readFileSync(file, 'utf8');
  expect(JSON.parse(facts).modelCalls[0]).toMatchObject({
    teammateId: 'a',
    offeredIds: [],
    proposedIds: ['file.readText'],
  });
  expect(facts).not.toMatch(/PRIVATE_|r54-input|systemContext|inputSchema/);
  const restarted = new ToolShortlistFixtureObserver(file, () => []).modelGateway(
    new FakeModelGateway(),
  ) as ModelGateway;
  await restarted.generateWithTools!({
    teammateId: 'b',
    runtimeProfileId: 'runtime-b',
    messages: [{ role: 'user', content: '__R54_READ__' }],
    tools: [],
  });
  expect(JSON.parse(readFileSync(file, 'utf8')).modelCalls).toHaveLength(2);
});

it('persists decision shape and hashes, never task or descriptor bodies', async () => {
  const { file, observer } = fixture();
  const request = {
    decisionType: 'TOOL_RELEVANCE',
    stateHash: 'hash',
    policyVersion: 'policy',
    questionVersion: 'question',
    questions: {},
    state: {
      context: { objective: 'PRIVATE_TASK_SENTINEL' },
      candidates: [{ id: 'tool-a', description: 'PRIVATE_DESCRIPTOR_SENTINEL' }],
    },
    inputSummary: {},
  } as unknown as DecisionRequest;
  await observer
    .decisionGateway({
      evaluate: async () => ({ answers: {}, confidence: {}, selectedAction: null }),
    })
    .evaluate(request);
  const facts = readFileSync(file, 'utf8');
  expect(JSON.parse(facts).decisions[0]).toMatchObject({
    candidateIds: ['tool-a'],
    stateFields: ['context', 'candidates'],
  });
  expect(facts).not.toMatch(/PRIVATE_TASK_SENTINEL|PRIVATE_DESCRIPTOR_SENTINEL/);
});
