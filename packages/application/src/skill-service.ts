import type { Skill } from '@cultivation/domain';

/** Assignment is scoped to the stable Teammate id, so Runtime changes do not affect it. */
export interface TeammateSkillAssignment {
  teammateId: string;
  skillId: string;
  enabled: boolean;
}

/** Immutable content snapshot created for each Skill revision. */
export interface SkillRevision {
  id: string;
  skillId: string;
  version: string;
  name: string;
  description: string;
  instructions: string;
  tags: string[];
  createdAt: string;
}

/**
 * Persistence port. saveSkill must atomically save the current Skill and create an
 * immutable revision when a new content version is written. Revisions are read-only.
 */
export interface SkillServiceStore {
  getSkill(id: string): Promise<Skill | null>;
  listSkills(): Promise<Skill[]>;
  saveSkill(skill: Skill): Promise<void>;
  listSkillRevisions(skillId: string): Promise<SkillRevision[]>;
  getAssignment(teammateId: string, skillId: string): Promise<TeammateSkillAssignment | null>;
  listAssignmentsForTeammate(teammateId: string): Promise<TeammateSkillAssignment[]>;
  saveAssignment(assignment: TeammateSkillAssignment): Promise<void>;
  deleteAssignment(teammateId: string, skillId: string): Promise<void>;
}

export interface SkillServiceClock {
  now(): string;
  newId(): string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  instructions: string;
  tags?: string[];
}

export interface UpdateSkillInput extends CreateSkillInput {
  id: string;
  /** Optional optimistic concurrency guard. */
  expectedVersion?: string;
}

export type SkillServiceErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'ARCHIVED'
  | 'CONFLICT'
  | 'ASSIGNMENT_NOT_FOUND';

export class SkillServiceError extends Error {
  constructor(
    readonly code: SkillServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SkillServiceError';
  }
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_INSTRUCTIONS_LENGTH = 24_000;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;

function normalizeInput(input: CreateSkillInput): CreateSkillInput {
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new SkillServiceError(
      'INVALID_INPUT',
      `Skill name must be 1-${MAX_NAME_LENGTH} characters.`,
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillServiceError(
      'INVALID_INPUT',
      `Skill description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  if (!instructions || instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new SkillServiceError(
      'INVALID_INPUT',
      `Skill instructions must be 1-${MAX_INSTRUCTIONS_LENGTH} characters.`,
    );
  }
  if (tags.length > MAX_TAGS || tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new SkillServiceError(
      'INVALID_INPUT',
      `Skills support up to ${MAX_TAGS} tags of at most ${MAX_TAG_LENGTH} characters each.`,
    );
  }
  return { name, description, instructions, tags };
}

function incrementPatch(version: string): string {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new SkillServiceError(
      'CONFLICT',
      `Cannot edit Skill with unsupported version format: ${version}.`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger) || patch === Number.MAX_SAFE_INTEGER) {
    throw new SkillServiceError('CONFLICT', 'Skill version is outside the supported range.');
  }
  return `${major}.${minor}.${patch + 1}`;
}

export class SkillService {
  constructor(
    private readonly store: SkillServiceStore,
    private readonly clock: SkillServiceClock,
  ) {}

  async list(): Promise<Skill[]> {
    return this.store.listSkills();
  }

  async get(id: string): Promise<Skill | null> {
    return this.store.getSkill(id);
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    const normalized = normalizeInput(input);
    const now = this.clock.now();
    const skill: Skill = {
      id: this.clock.newId(),
      ...normalized,
      tags: normalized.tags ?? [],
      version: '1.0.0',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveSkill(skill);
    return skill;
  }

  async update(input: UpdateSkillInput): Promise<Skill> {
    const current = await this.store.getSkill(input.id);
    if (!current) throw new SkillServiceError('NOT_FOUND', 'Skill was not found.');
    if (current.status !== 'ACTIVE') {
      throw new SkillServiceError('ARCHIVED', 'Archived Skills cannot be edited.');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new SkillServiceError('CONFLICT', 'Skill changed since it was loaded.');
    }
    const normalized = normalizeInput(input);
    const updated: Skill = {
      ...current,
      ...normalized,
      tags: normalized.tags ?? [],
      version: incrementPatch(current.version),
      updatedAt: this.clock.now(),
    };
    await this.store.saveSkill(updated);
    return updated;
  }

  async archive(id: string): Promise<Skill> {
    const current = await this.store.getSkill(id);
    if (!current) throw new SkillServiceError('NOT_FOUND', 'Skill was not found.');
    if (current.status === 'ARCHIVED') return current;
    const archived: Skill = { ...current, status: 'ARCHIVED', updatedAt: this.clock.now() };
    await this.store.saveSkill(archived);
    return archived;
  }

  async listRevisions(skillId: string): Promise<SkillRevision[]> {
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new SkillServiceError('NOT_FOUND', 'Skill was not found.');
    return this.store.listSkillRevisions(skillId);
  }

  async listAssignments(teammateId: string): Promise<TeammateSkillAssignment[]> {
    return this.store.listAssignmentsForTeammate(teammateId);
  }

  async assign(teammateId: string, skillId: string): Promise<TeammateSkillAssignment> {
    this.requireId(teammateId, 'Teammate');
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new SkillServiceError('NOT_FOUND', 'Skill was not found.');
    if (skill.status !== 'ACTIVE') {
      throw new SkillServiceError('ARCHIVED', 'Archived Skills cannot be assigned.');
    }
    const existing = await this.store.getAssignment(teammateId, skillId);
    if (existing) return existing;
    const assignment: TeammateSkillAssignment = {
      teammateId,
      skillId,
      enabled: false,
    };
    await this.store.saveAssignment(assignment);
    return assignment;
  }

  async unassign(teammateId: string, skillId: string): Promise<void> {
    this.requireId(teammateId, 'Teammate');
    await this.store.deleteAssignment(teammateId, skillId);
  }

  async enable(teammateId: string, skillId: string): Promise<TeammateSkillAssignment> {
    return this.setEnabled(teammateId, skillId, true);
  }

  async disable(teammateId: string, skillId: string): Promise<TeammateSkillAssignment> {
    return this.setEnabled(teammateId, skillId, false);
  }

  private async setEnabled(
    teammateId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<TeammateSkillAssignment> {
    this.requireId(teammateId, 'Teammate');
    const assignment = await this.store.getAssignment(teammateId, skillId);
    if (!assignment) {
      throw new SkillServiceError(
        'ASSIGNMENT_NOT_FOUND',
        'Skill is not assigned to this Teammate.',
      );
    }
    if (enabled) {
      const skill = await this.store.getSkill(skillId);
      if (!skill) throw new SkillServiceError('NOT_FOUND', 'Skill was not found.');
      if (skill.status !== 'ACTIVE') {
        throw new SkillServiceError('ARCHIVED', 'Archived Skills cannot be enabled.');
      }
    }
    const updated = { ...assignment, enabled };
    await this.store.saveAssignment(updated);
    return updated;
  }

  private requireId(id: string, label: string): void {
    if (!id.trim()) throw new SkillServiceError('INVALID_INPUT', `${label} id is required.`);
  }
}
