import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SkillRoutingContext } from '@cultivation/application/r5-1-skill-routing';
import type { DecisionGateway, DecisionRequest } from '@cultivation/application/r0-decision';
import type { ModelGateway, ModelMessage } from '@cultivation/application';

/** Explicit packaged-test observation only; production never constructs this object. */
export class SkillRoutingFixtureObserver {
  private readonly modelCalls: Record<string, unknown>[] = [];
  private readonly decisions: Record<string, unknown>[] = [];
  constructor(
    private readonly file: string,
    private readonly callContext: (teammateId: string) => Record<string, unknown> = () => ({}),
  ) {}
  private save(): void {
    writeFileSync(
      this.file,
      JSON.stringify({ modelCalls: this.modelCalls, decisions: this.decisions }, null, 2),
      'utf8',
    );
  }
  decisionGateway(gateway: DecisionGateway): DecisionGateway {
    return {
      evaluate: async (request: DecisionRequest) => {
        const stateText = JSON.stringify(request.state);
        const context = request.state.context as SkillRoutingContext;
        const hashText = (value: string) =>
          createHash('sha256').update(value, 'utf8').digest('hex');
        this.decisions.push({
          type: request.decisionType,
          questionVersion: request.questionVersion,
          stateHash: request.stateHash,
          candidateIds: [...request.inputSummary.candidateIds],
          contextKeys: Object.keys(request.state),
          contextFacts: {
            fields: Object.keys(context),
            objectiveHash: hashText(context.objective),
            phase: context.phase,
            stepType: context.stepType,
            requiredCapabilities: context.requiredCapabilities,
            publicState: context.publicState,
            inputArtifactSummaries: context.inputArtifactSummaries?.map((artifact) => ({
              id: artifact.id,
              kind: artifact.kind,
              nameHash: hashText(artifact.name),
              fields: Object.keys(artifact),
            })),
            expectedOutputContract: context.expectedOutputContract?.map((output) => ({
              keyHash: hashText(output.key),
              kind: output.kind,
              contractIdHash: output.contractId ? hashText(output.contractId) : null,
              contractVersion: output.contractVersion,
            })),
          },
          historyLeak:
            /HISTORY_SENTINEL|PRIVATE_MEMORY_SENTINEL|PRIVATE_INSTRUCTIONS_SENTINEL/.test(
              stateText,
            ),
          containsInstructionMarker: /PRIVATE_INSTRUCTIONS_SENTINEL/.test(stateText),
        });
        if (this.decisions.length > 256) throw new Error('Fixture decision evidence limit');
        this.save();
        return gateway.evaluate(request);
      },
    };
  }
  modelGateway<T extends ModelGateway>(gateway: T): T {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (!['generate', 'generateWithTools', 'proposeCollaboration'].includes(String(property)))
          return value.bind(target);
        return (...args: unknown[]) => {
          const request = args[0] as {
            teammateId: string;
            runtimeProfileId: string;
            messages?: ModelMessage[];
            systemContext?: string;
            participantOutcomeContract?: string;
          };
          const system =
            request.systemContext ??
            request.messages
              ?.filter((message) => message.role === 'system')
              .map((message) => message.content)
              .join('\n') ??
            '';
          const match = /\[ACTIVE SKILLS[^\n]*\]\n([^\n]*)/.exec(system);
          const skills: Array<{ id: string; text: string }> = match ? JSON.parse(match[1]!) : [];
          this.modelCalls.push({
            ...this.callContext(request.teammateId),
            teammateId: request.teammateId,
            runtimeProfileId: request.runtimeProfileId,
            method: String(property),
            selectedSkillIds: skills.map((skill) => skill.id),
            instructionCharacters: skills.reduce((sum, skill) => sum + skill.text.length, 0),
            skillSectionCharacters: match?.[0].length ?? 0,
            structuredOutcomeContract: request.participantOutcomeContract ?? null,
          });
          if (this.modelCalls.length > 256) throw new Error('Fixture model evidence limit');
          this.save();
          return value.apply(target, args);
        };
      },
    });
  }
}
