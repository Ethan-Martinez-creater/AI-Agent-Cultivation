import { describe, expect, it } from 'vitest';
import { canTransition, transition, type Mission, type MissionState } from './index.js';

const base: Mission = {
  id: 'm1',
  title: 'Test',
  objective: 'Test',
  initiatorType: 'USER',
  initiatorId: 'u1',
  coordinatorTeammateId: 't1',
  partyId: null,
  mode: 'SOLO',
  state: 'DRAFT',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
};

describe('Mission state machine', () => {
  it('accepts the documented execution path', () => {
    let mission = transition(base, 'READY');
    mission = transition(mission, 'RUNNING');
    mission = transition(mission, 'WAITING_APPROVAL');
    mission = transition(mission, 'RUNNING');
    mission = transition(mission, 'COMPLETED', '2026-01-02T00:00:00Z');
    expect(mission.completedAt).toBe('2026-01-02T00:00:00Z');
    expect(mission.id).toBe(base.id);
    expect(base.state).toBe('DRAFT');
  });

  it('rejects invalid and self transitions', () => {
    expect(() => transition(base, 'COMPLETED')).toThrow('Illegal Mission transition');
    try {
      transition(base, 'COMPLETED');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MISSION_INVALID_STATE' });
    }
    expect(canTransition('RUNNING', 'RUNNING')).toBe(false);
    for (const state of ['COMPLETED', 'CANCELLED'] as MissionState[])
      expect(canTransition(state, 'READY')).toBe(false);
  });

  it('supports pause and crash recovery transitions', () => {
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'INTERRUPTED')).toBe(true);
    expect(canTransition('INTERRUPTED', 'READY')).toBe(true);
  });
});
