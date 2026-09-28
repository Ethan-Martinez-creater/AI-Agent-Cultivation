import { CAPABILITY_DIMENSIONS } from '@cultivation/application';
import type { DecisionCandidateInput } from '@cultivation/application/r3-decision-state';
import type { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import type { HumanBridgeService } from '@cultivation/application/r2-human-bridge-service';
import type {
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate6SqliteRepository,
} from '@cultivation/persistence';

/** Reads only allowlisted summaries; Memory, messages, files and events are never queried. */
export function buildR3ShadowCandidates(
  selectedTeammateId: string,
  stores: {
    teammates: Gate1SqliteRepository;
    skills: Gate2SqliteRepository;
    experiences: Gate6SqliteRepository;
    capabilities: R1CapabilityService;
    humanBridge: HumanBridgeService;
  },
): DecisionCandidateInput[] {
  const eligible = stores.teammates
    .listTeammates()
    .filter(
      (teammate) =>
        teammate.status === 'ACTIVE' &&
        (teammate.executorKind === 'USER_BRIDGE' || teammate.currentRuntimeProfileId !== null),
    )
    .sort((a, b) =>
      a.id === selectedTeammateId ? -1 : b.id === selectedTeammateId ? 1 : a.id.localeCompare(b.id),
    )
    .slice(0, 8);
  const skills = stores.skills.listSkills('ACTIVE');
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));

  return eligible.map((teammate) => {
    const capabilities: DecisionCandidateInput['capabilities'] = {};
    if (teammate.executorKind === 'USER_BRIDGE') {
      const bridge = stores.humanBridge.capabilityProfile();
      for (const dimension of bridge.dimensions) {
        capabilities[dimension.dimension] = dimension.enabled
          ? { status: 'SUPPORTED', score: dimension.currentScore ?? dimension.priorScore }
          : { status: 'UNSUPPORTED', score: null };
      }
    } else {
      const profile = stores.capabilities.profile(teammate.id);
      for (const dimension of profile.dimensions) {
        capabilities[dimension.dimension] = !dimension.prior
          ? { status: 'UNCONFIGURED', score: null }
          : dimension.prior.supported
            ? { status: 'SUPPORTED', score: dimension.currentScore }
            : { status: 'UNSUPPORTED', score: null };
      }
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
