import type { Mission, MissionState } from './index.js';
import { DomainError } from '@cultivation/shared';

const transitions: Readonly<Record<MissionState, readonly MissionState[]>> = {
  DRAFT: ['READY'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: [
    'WAITING_APPROVAL',
    'WAITING_COLLABORATION',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED',
  ],
  WAITING_APPROVAL: ['RUNNING', 'CANCELLED'],
  WAITING_COLLABORATION: ['RUNNING', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['READY'],
  CANCELLED: [],
  INTERRUPTED: ['READY', 'CANCELLED'],
};

export function canTransition(from: MissionState, to: MissionState): boolean {
  return transitions[from].includes(to);
}

export function transition(
  mission: Mission,
  to: MissionState,
  at: string = new Date().toISOString(),
): Mission {
  if (!canTransition(mission.state, to)) {
    throw new DomainError(
      'MISSION_INVALID_STATE',
      `Illegal Mission transition: ${mission.state} -> ${to}`,
      { from: mission.state, to },
    );
  }
  return {
    ...mission,
    state: to,
    updatedAt: at,
    completedAt: to === 'COMPLETED' ? at : mission.completedAt,
  };
}
