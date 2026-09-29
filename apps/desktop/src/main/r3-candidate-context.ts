import { CAPABILITY_DIMENSIONS } from '@cultivation/application';
import type { DecisionCandidateInput } from '@cultivation/application/r3-decision-state';
import type { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import type {
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate6SqliteRepository,
} from '@cultivation/persistence';

export interface R3CandidateBindingEligibility {
  /** True only for a sealed binding whose Provider and Runtime snapshot are structurally valid. */
  hasValidModelBinding(teammateId: string): boolean;
}

/** Reads only allowlisted summaries; Memory, messages, files and events are never queried. */
export function buildR3ShadowCandidates(
  selectedTeammateId: string,
  stores: {
    teammates: Gate1SqliteRepository;
    skills: Gate2SqliteRepository;
    experiences: Gate6SqliteRepository;
    capabilities: R1CapabilityService;
    bindingEligibility: R3CandidateBindingEligibility;
  },
): DecisionCandidateInput[] {
  const eligible = stores.teammates
    .listTeammates()
    .filter(
      (teammate) =>
        teammate.status === 'ACTIVE' &&
        teammate.executorKind === 'MODEL_RUNTIME' &&
        teammate.systemKind !== 'HUMAN_BRIDGE' &&
        teammate.routingPolicy !== 'FALLBACK_ONLY' &&
        teammate.currentRuntimeProfileId !== null &&
        stores.bindingEligibility.hasValidModelBinding(teammate.id),
    )
    .sort((a, b) =>
      a.id === selectedTeammateId ? -1 : b.id === selectedTeammateId ? 1 : a.id.localeCompare(b.id),
    )
    .slice(0, 8);
  const skills = stores.skills.listSkills('ACTIVE');
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));

  return eligible.map((teammate) => {
    const capabilities: DecisionCandidateInput['capabilities'] = {};
    const profile = stores.capabilities.profile(teammate.id);
    for (const dimension of profile.dimensions) {
      const prior = dimension.prior;
      const score = prior?.normalizedScore;
      capabilities[dimension.dimension] = !prior
        ? { status: 'UNCONFIGURED', score: null }
        : prior.supported &&
            typeof score === 'number' &&
            Number.isFinite(score) &&
            score >= 0 &&
            score <= 100
          ? { status: 'SUPPORTED', score }
          : { status: 'UNSUPPORTED', score: null };
    }
    for (const dimension of CAPABILITY_DIMENSIONS) {
      capabilities[dimension] ??= { status: 'UNCONFIGURED', score: null };
    }
    const enabledSkills = stores.skills
      .listSkillAssignments(teammate.id)
      .filter((assignment) => assignment.enabled)
      .map((assignment) => skillsById.get(assignment.skillId))
      .filter((skill) => skill !== undefined)
      .slice(0, 6)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.tags[0] ?? 'DECLARATIVE',
        summary: skill.description,
      }));
    const verifiedExperiences = stores.experiences
      .listExperienceEvents(teammate.id)
      .slice(-6)
      .reverse()
      .map((event) => ({
        verified: true,
        type: event.experienceType,
        mode: event.mode,
        outcome: event.outcome,
        role: event.role,
        createdAt: event.createdAt,
      }));
    return {
      id: teammate.id,
      roleTitle: teammate.title ?? teammate.name,
      capabilities,
      enabledSkills,
      verifiedExperiences,
    };
  });
}
