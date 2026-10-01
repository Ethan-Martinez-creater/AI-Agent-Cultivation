import { FakeDecisionGateway } from '@cultivation/agent-runtime';
import type { DecisionGateway } from '@cultivation/application/r0-decision';

/** Opt-in packaged test fixture; never selected by normal startup or cloud configuration. */
export function routingFixtureGateway(): DecisionGateway {
  const fake = new FakeDecisionGateway();
  return {
    evaluate: async (request) => {
      const result = await fake.evaluate(request);
      if (request.decisionType === 'TASK_CAPABILITY') {
        result.answers.demands = (
          result.answers.demands as Array<{
            dimension: string;
            probability: number;
            required: boolean;
          }>
        ).map((item) => ({
          ...item,
          probability: item.dimension === 'GENERAL_REASONING' ? 1 : 0,
          required: item.dimension === 'GENERAL_REASONING',
        }));
      } else if (request.decisionType === 'TEAMMATE_FIT') {
        result.answers.teammate = 'NONE';
        result.selectedAction = 'NONE';
        result.choiceProbabilities = Object.fromEntries(
          Object.keys(request.questions.teammate!.criteria ?? {}).map((id) => [
            id,
            id === 'NONE' ? 1 : 0,
          ]),
        );
      } else if (request.decisionType === 'COLLABORATION_NEED') {
        const party = request.inputSummary.taskSummary.includes('[R4_PARTY]');
        result.answers.collaboration = party ? 'YES' : 'NO';
        result.selectedAction = party ? 'YES' : 'NO';
      }
      return result;
    },
  };
}
