import { describe, expect, it } from 'vitest';
import type { Skill } from '@cultivation/domain';
import {
  SkillService,
  SkillServiceError,
  type SkillRevision,
  type SkillServiceClock,
  type SkillServiceStore,
  type TeammateSkillAssignment,
} from './skill-service.js';

function setup() {
  const skills = new Map<string, Skill>();
  const revisions = new Map<string, SkillRevision[]>();
  const assignments = new Map<string, TeammateSkillAssignment>();
  let nextId = 0;
  let time = 0;
  const clock: SkillServiceClock = {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, time++)).toISOString(),
    newId: () => `id-${++nextId}`,
  };
  const store: SkillServiceStore = {
    getSkill: async (id) => skills.get(id) ?? null,
    listSkills: async () => [...skills.values()],
    saveSkill: async (skill) => {
      skills.set(skill.id, skill);
      const history = revisions.get(skill.id) ?? [];
      if (!history.some((revision) => revision.version === skill.version)) {
        history.push({
          id: `revision-${skill.id}-${skill.version}`,
          skillId: skill.id,
          version: skill.version,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          tags: [...skill.tags],
          createdAt: skill.updatedAt,
        });
        revisions.set(skill.id, history);
      }
    },
    listSkillRevisions: async (skillId) => [...(revisions.get(skillId) ?? [])],
    getAssignment: async (teammateId, skillId) =>
      assignments.get(`${teammateId}:${skillId}`) ?? null,
    listAssignmentsForTeammate: async (teammateId) =>
      [...assignments.values()].filter((assignment) => assignment.teammateId === teammateId),
    saveAssignment: async (assignment) => {
      assignments.set(`${assignment.teammateId}:${assignment.skillId}`, assignment);
    },
    deleteAssignment: async (teammateId, skillId) => {
      assignments.delete(`${teammateId}:${skillId}`);
    },
  };
  return { service: new SkillService(store, clock), store, assignments };
}

describe('SkillService', () => {
  it('creates declarative Skills and records content revisions on edits', async () => {
    const { service, store } = setup();
    const created = await service.create({
      name: 'Research notes',
      description: 'Summarize sources',
      instructions: 'Compare claims against cited evidence.',
      tags: ['research'],
    });
    expect(created.version).toBe('1.0.0');
    expect(created.status).toBe('ACTIVE');

    const updated = await service.update({
      id: created.id,
      expectedVersion: '1.0.0',
      name: 'Research notes',
      description: 'Summarize sources carefully',
      instructions: 'Compare claims against cited evidence. Show uncertainty.',
      tags: ['research', 'sources'],
    });
    expect(updated.version).toBe('1.0.1');
    expect(await service.listRevisions(created.id)).toMatchObject([
      { version: '1.0.0', instructions: 'Compare claims against cited evidence.' },
      {
        version: '1.0.1',
        instructions: 'Compare claims against cited evidence. Show uncertainty.',
      },
    ]);
    expect(await store.getSkill(created.id)).toEqual(updated);
    await expect(
      service.update({
        id: created.id,
        expectedVersion: '1.0.0',
        name: 'Outdated',
        description: '',
        instructions: 'Old update',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('archives Skills and keeps assignment, enable and disable scoped to a Teammate', async () => {
    const { service, assignments } = setup();
    const skill = await service.create({
      name: 'Writing',
      description: 'Writing help',
      instructions: 'Use short sentences.',
    });
    const assigned = await service.assign('teammate-a', skill.id);
    expect(assigned.enabled).toBe(false);
    expect(await service.listAssignments('teammate-b')).toEqual([]);

    const enabled = await service.enable('teammate-a', skill.id);
    expect(enabled.enabled).toBe(true);
    expect(await service.listAssignments('teammate-a')).toEqual([enabled]);
    const disabled = await service.disable('teammate-a', skill.id);
    expect(disabled.enabled).toBe(false);
    expect(assignments.has(`teammate-a:${skill.id}`)).toBe(true);

    const archived = await service.archive(skill.id);
    expect(archived.status).toBe('ARCHIVED');
    await expect(service.enable('teammate-a', skill.id)).rejects.toMatchObject({
      code: 'ARCHIVED',
    });
    await expect(service.assign('teammate-b', skill.id)).rejects.toBeInstanceOf(SkillServiceError);
    await service.unassign('teammate-a', skill.id);
    expect(await service.listAssignments('teammate-a')).toEqual([]);
    expect((await service.list()).find((item) => item.id === skill.id)?.status).toBe('ARCHIVED');
  });
});
