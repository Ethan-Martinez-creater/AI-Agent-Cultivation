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

const exactResourcePrefix = '\u0000cultivation.exact-resource.v1:';

function encodeExactResource(resource: string): string {
  let encoded = '';
  for (let index = 0; index < resource.length; index += 1) {
    encoded += resource.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `${exactResourcePrefix}${encoded}`;
}

function exactResourceFromPattern(pattern: string): string | null {
  if (!pattern.startsWith(exactResourcePrefix)) return null;
  const encoded = pattern.slice(exactResourcePrefix.length);
  if (encoded.length % 4 !== 0 || !/^[0-9a-f]*$/.test(encoded)) return null;
  let resource = '';
  for (let index = 0; index < encoded.length; index += 4) {
    resource += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  }
  return resource;
}

function resourceMatches(pattern: string, resource: string): boolean {
  const exactResource = exactResourceFromPattern(pattern);
  if (exactResource !== null) return exactResource === resource;
  if (pattern === '*') return true;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(resource);
}

const scopeRank: Readonly<Record<PermissionScopeRef['scope'], number>> = {
  GLOBAL: 0,
  TEAMMATE: 1,
  MISSION: 2,
};

/**
 * Evaluates only rules for the exact subject/capability, then applies the scope
 * of each rule against the current Teammate and Mission. Unmatched Mission rules
 * never affect another Mission. Any applicable DENY wins; otherwise the most
 * specific scope decides, with ASK winning over ALLOW at that scope. With no
 * applicable rule the safe outcome is ASK.
 */
export class PermissionEngine {
  constructor(private readonly rules: PermissionRuleStore) {}

  /**
   * Saves a one-resource Mission grant. The resourcePattern argument is treated
   * as a literal resource, so wildcard characters and backslashes cannot widen
   * the grant. The tagged encoding stays in the existing text column and leaves
   * legacy glob rules unchanged.
   */
  grantExactMission(rule: PermissionRule): void {
    this.validateMissionGrant(rule);
    this.rules.savePermissionRule({
      ...rule,
      resourcePattern: encodeExactResource(rule.resourcePattern),
    });
  }

  /** Backwards-compatible safe default: Mission grants are exact by default. */
  grantMission(rule: PermissionRule): void {
    this.grantExactMission(rule);
  }

  /** Explicit opt-in for a Mission-scoped glob PermissionRule. */
  grantMissionPattern(rule: PermissionRule): void {
    this.validateMissionGrant(rule);
    this.rules.savePermissionRule(rule);
  }

  private validateMissionGrant(rule: PermissionRule): void {
    if (rule.scope !== 'MISSION' || rule.decision !== 'ALLOW' || !rule.scopeId) {
      throw new Error('Invalid Mission grant');
    }
  }

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
    const highestScope = Math.max(...applicable.map((rule) => scopeRank[rule.scope]));
    const decision: PermissionDecision = applicable.some((rule) => rule.decision === 'DENY')
      ? 'DENY'
      : applicable.some((rule) => scopeRank[rule.scope] === highestScope && rule.decision === 'ASK')
        ? 'ASK'
        : 'ALLOW';
    return {
      decision,
      matchedRuleIds: applicable.map((rule) => rule.id).sort(),
    };
  }
}
