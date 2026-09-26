import type {
  PermissionCapability,
  PermissionDecision,
  PermissionRule,
  PermissionScopeRef,
} from '@cultivation/domain';

export interface PermissionRuleStore {
  listPermissionRules(
    subjectType: PermissionRule['subjectType'],
    subjectId: string,
    capability: PermissionCapability,
  ): PermissionRule[];
  savePermissionRule(rule: PermissionRule): void;
}

export interface PermissionCheck {
  subjectType: PermissionRule['subjectType'];
  subjectId: string;
  capability: PermissionCapability;
  resource: string;
  teammateId: string | null;
  missionId: string | null;
}

export interface PermissionResult {
  decision: PermissionDecision;
  matchedRuleIds: string[];
}

function scopeApplies(scope: PermissionScopeRef, check: PermissionCheck): boolean {
  switch (scope.scope) {
    case 'GLOBAL':
      return scope.scopeId === null;
    case 'TEAMMATE':
      return check.teammateId !== null && scope.scopeId === check.teammateId;
    case 'MISSION':
      return check.missionId !== null && scope.scopeId === check.missionId;
  }
}

function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(resource);
}

const decisionRank: Readonly<Record<PermissionDecision, number>> = {
  DENY: 0,
  ASK: 1,
  ALLOW: 2,
};

/**
 * Evaluates only rules for the exact subject/capability, then applies the scope
 * of each rule against the current Teammate and Mission. Unmatched Mission rules
 * never affect another Mission. With no explicit rule the safe outcome is ASK.
 */
export class PermissionEngine {
  constructor(private readonly rules: PermissionRuleStore) {}

  evaluate(check: PermissionCheck): PermissionResult {
    const applicable = this.rules
      .listPermissionRules(check.subjectType, check.subjectId, check.capability)
      .filter(
        (rule) =>
          rule.subjectType === check.subjectType &&
          rule.subjectId === check.subjectId &&
          rule.capability === check.capability &&
          resourceMatches(rule.resourcePattern, check.resource) &&
          scopeApplies(rule, check),
      );

    if (applicable.length === 0) return { decision: 'ASK', matchedRuleIds: [] };
    const decision = applicable
      .map((rule) => rule.decision)
      .sort((left, right) => decisionRank[left] - decisionRank[right])[0];
    return {
      decision: decision ?? 'ASK',
      matchedRuleIds: applicable.map((rule) => rule.id).sort(),
    };
  }
}
