import type { CapabilityProfile, ExperienceEvent } from '@cultivation/domain';

export interface Gate6ExperienceStore {
  /** Idempotently projects all durable Mission facts into the ExperienceEvent ledger. */
  reconcileExperienceEvents(): number;
  listExperienceEvents(teammateId: string): ExperienceEvent[];
}

export interface Gate6ExperienceSnapshot {
  events: ExperienceEvent[];
  profile: CapabilityProfile;
}

/** Read-only profile projection over the append-only ExperienceEvent ledger. */
export class Gate6ExperienceService {
  constructor(private readonly store: Gate6ExperienceStore) {}

  /** Safe to call at startup and repeatedly; returns only newly inserted ledger rows. */
  reconcileAll(): number {
    return this.store.reconcileExperienceEvents();
  }

  /** Reconcile durable facts, then rebuild both outputs directly from the ledger. */
  get(teammateId: string): Gate6ExperienceSnapshot {
    this.reconcileAll();
    const events = this.store.listExperienceEvents(teammateId);
    return { events, profile: buildCapabilityProfile(teammateId, events) };
  }
}

export function buildCapabilityProfile(
  teammateId: string,
  events: readonly ExperienceEvent[],
): CapabilityProfile {
  const profile: CapabilityProfile = {
    teammateId,
    completedMissions: 0,
    failedMissions: 0,
    cancelledMissions: 0,
    consultationParticipations: 0,
    reviewParticipations: 0,
    delegationParticipations: 0,
    toolUses: 0,
    completedCollaborations: 0,
    skillUses: 0,
    lastActiveAt: null,
  };
  for (const event of events) {
    if (event.teammateId !== teammateId) continue;
    if (event.experienceType === 'MISSION_RESULT') {
      if (event.outcome === 'COMPLETED') profile.completedMissions += 1;
      else if (event.outcome === 'FAILED') profile.failedMissions += 1;
      else if (event.outcome === 'CANCELLED') profile.cancelledMissions += 1;
    } else if (event.experienceType === 'COLLABORATION') {
      if (event.mode === 'CONSULTATION') profile.consultationParticipations += 1;
      else if (event.mode === 'REVIEW') profile.reviewParticipations += 1;
      else if (event.mode === 'DELEGATION') profile.delegationParticipations += 1;
      if (event.outcome === 'COMPLETED') profile.completedCollaborations += 1;
    } else if (event.experienceType === 'TOOL_USE') {
      profile.toolUses += 1;
    } else if (event.experienceType === 'SKILL_USE') {
      profile.skillUses += 1;
    }
    if (
      profile.lastActiveAt === null ||
      Date.parse(event.createdAt) > Date.parse(profile.lastActiveAt)
    ) {
      profile.lastActiveAt = event.createdAt;
    }
  }
  return profile;
}
