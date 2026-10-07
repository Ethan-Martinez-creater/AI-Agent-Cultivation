import type {
  DecisionGateway,
  DecisionRequest,
  DecisionResult,
} from '@cultivation/application/r0-decision';
import { validateMemoryPreGateRequest } from '@cultivation/application/r5-2-memory-pre-gate';

const skillIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/;

/** Local deterministic fixture gateway; evaluation never performs external calls. */
export class FakeDecisionGateway implements DecisionGateway {
  readonly #fixtures: ReadonlyMap<string, DecisionResult>;

  constructor(fixtures: ReadonlyMap<string, DecisionResult> = new Map()) {
    this.#fixtures = fixtures;
  }

  static key(request: Pick<DecisionRequest, 'decisionType' | 'stateHash'>): string {
    return `${request.decisionType}:${request.stateHash}`;
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    if ((request.decisionType as string) === 'MEMORY_EXTRACTION_NEED') {
      try {
        if (!validateMemoryPreGateRequest(request)) {
          return {
            answers: {},
            confidence: {},
            selectedAction: null,
            errorCode: 'INVALID_REQUEST',
          };
        }
        const state = request.state as {
          evidence: { semanticSignals: { durableStatement: boolean } };
        };
        const decision = state.evidence.semanticSignals.durableStatement
          ? 'RUN_EXTRACTION'
          : 'SKIP_EXTRACTION';
        return {
          answers: { extraction: decision },
          confidence: { extraction: 1 },
          selectedAction: null,
          errorCode: null,
        };
      } catch {
        return { answers: {}, confidence: {}, selectedAction: null, errorCode: 'INVALID_REQUEST' };
      }
    }

    const fixture = this.#fixtures.get(FakeDecisionGateway.key(request));
    if (fixture) return structuredClone(fixture);

    const extended = request as DecisionRequest & {
      questions?: Record<
        string,
        | { type: 'noul'; instructions: string; criteria?: Record<string, string | null> }
        | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
      >;
    };
    const questions = extended.questions;
    if (!questions || Object.keys(questions).length === 0) {
      return { answers: {}, confidence: {}, selectedAction: null };
    }

    if ((request.decisionType as string) === 'SKILL_RELEVANCE') {
      const candidateIds = request.inputSummary?.candidateIds;
      const expectedQuestionKeys = Array.isArray(candidateIds)
        ? candidateIds.map((id) => `skill.${id}`).sort()
        : [];
      const actualQuestionKeys = Object.keys(questions).sort();
      if (
        !Array.isArray(candidateIds) ||
        candidateIds.length < 1 ||
        candidateIds.length > 24 ||
        candidateIds.some((id) => typeof id !== 'string' || !skillIdPattern.test(id)) ||
        new Set(candidateIds).size !== candidateIds.length ||
        actualQuestionKeys.length !== expectedQuestionKeys.length ||
        actualQuestionKeys.some((key, index) => key !== expectedQuestionKeys[index]) ||
        Object.values(questions).some(
          (question) => question.type !== 'noul' || Object.hasOwn(question, 'criteria'),
        )
      ) {
        return { answers: {}, confidence: {}, selectedAction: null };
      }
      const skills = candidateIds
        .map((skillId, index) => ({
          skillId,
          score: 1 - index / (candidateIds.length + 1),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0),
        )
        .slice(0, 3);
      return { answers: { skills }, confidence: {}, selectedAction: null };
    }

    const answers: Record<string, unknown> = {};
    const confidence: Record<string, number> = {};
    let choiceProbabilities: Record<string, number> | undefined;
    let selectedAction: string | null = null;

    if (request.decisionType === 'TASK_CAPABILITY') {
      const dimensions = new Set<string>();
      for (const key of Object.keys(questions)) {
        const match = /^demand\.([A-Z_]+)\.(?:probability|required)$/.exec(key);
        if (match) dimensions.add(match[1]!);
      }
      const demands = [...dimensions].sort().map((dimension) => {
        const probabilityQuestion = questions[`demand.${dimension}.probability`];
        const requiredQuestion = questions[`demand.${dimension}.required`];
        if (probabilityQuestion?.type !== 'noul' || requiredQuestion?.type !== 'choice')
          return null;
        const requiredOptions = Object.keys(requiredQuestion.criteria);
        if (!requiredOptions.includes('YES') || !requiredOptions.includes('NO')) return null;
        confidence[`demand.${dimension}.required`] = 1;
        return { dimension, probability: 0.25, required: false };
      });
      if (demands.length > 0 && demands.every((demand) => demand !== null))
        answers.demands = demands;
    } else if (request.decisionType === 'TEAMMATE_FIT') {
      const question = questions.teammate;
      if (question?.type === 'choice') {
        const candidates = Object.keys(question.criteria).filter(
          (candidate) => candidate !== 'NONE',
        );
        const teammate = candidates[0] ?? 'NONE';
        answers.teammate = teammate;
        choiceProbabilities = Object.fromEntries(
          Object.keys(question.criteria).map((candidate) => [
            candidate,
            candidate === teammate ? 1 : 0,
          ]),
        );
        confidence.teammate = 1;
        selectedAction = teammate;
      }
    } else if (request.decisionType === 'COLLABORATION_NEED') {
      const question = questions.collaboration;
      if (question?.type === 'choice' && Object.hasOwn(question.criteria, 'NO')) {
        answers.collaboration = 'NO';
        confidence.collaboration = 1;
        selectedAction = 'NO';
      }
    } else if (request.decisionType === 'REVIEW_NEED') {
      const question = questions.review;
      if (question?.type === 'choice' && Object.hasOwn(question.criteria, 'NO')) {
        answers.review = 'NO';
        confidence.review = 1;
        selectedAction = 'NO';
      }
    }

    return Object.keys(answers).length > 0
      ? { answers, confidence, selectedAction, ...(choiceProbabilities && { choiceProbabilities }) }
      : { answers: {}, confidence: {}, selectedAction: null };
  }
}
