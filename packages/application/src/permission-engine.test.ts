import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@cultivation/domain';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';

class RuleStore implements PermissionRuleStore {
  readonly values: PermissionRule[] = [];

  listPermissionRules(
    subjectType: PermissionRule['subjectType'],
    subjectId: string,
    capability: PermissionRule['capability'],
  ): PermissionRule[] {
    return this.values.filter(
      (rule) =>
        rule.subjectType === subjectType &&
        rule.subjectId === subjectId &&
        rule.capability === capability,
    );
  }

  savePermissionRule(rule: PermissionRule): void {
    this.values.push(rule);
  }
}

let nextRuleId = 0;
function rule(
  scope: PermissionRule['scope'],
  scopeId: string | null,
  decision: PermissionRule['decision'],
  resourcePattern = '*',
): PermissionRule {
  nextRuleId += 1;
  return {
    id: `rule-${nextRuleId}`,
    subjectType: 'TEAMMATE',
    subjectId: 'teammate-1',
    capability: 'SPEND_BUDGET',
    resourcePattern,
    decision,
    scope,
    scopeId,
  } as PermissionRule;
}

describe('PermissionEngine', () => {
  it('matches GLOBAL and TEAMMATE scopes, and defaults to ASK', () => {
    const store = new RuleStore();
    store.savePermissionRule(rule('GLOBAL', null, 'ALLOW'));
    store.savePermissionRule(rule('TEAMMATE', 'teammate-1', 'ASK'));
    const engine = new PermissionEngine(store);

    expect(
      engine.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'teammate-1',
        capability: 'SPEND_BUDGET',
        resource: 'mission:fixture',
        teammateId: 'teammate-1',
        missionId: 'mission-1',
      }).decision,
    ).toBe('ASK');
    expect(
      engine.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'teammate-1',
        capability: 'SPEND_BUDGET',
        resource: 'mission:fixture',
        teammateId: 'teammate-2',
        missionId: 'mission-2',
      }).decision,
    ).toBe('ALLOW');
    expect(
      engine.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'another-subject',
        capability: 'SPEND_BUDGET',
        resource: 'mission:fixture',
        teammateId: 'teammate-1',
        missionId: 'mission-1',
      }).decision,
    ).toBe('ASK');
  });

  it('does not leak a Mission grant to another Mission and DENY outranks ASK/ALLOW', () => {
    const store = new RuleStore();
    store.savePermissionRule(rule('GLOBAL', null, 'ALLOW'));
    store.savePermissionRule(rule('MISSION', 'mission-1', 'ALLOW'));
    store.savePermissionRule(rule('MISSION', 'mission-2', 'ASK'));
    const engine = new PermissionEngine(store);
    const evaluate = (missionId: string) =>
      engine.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'teammate-1',
        capability: 'SPEND_BUDGET',
        resource: 'mission:fixture',
        teammateId: 'teammate-1',
        missionId,
      });

    expect(evaluate('mission-1').decision).toBe('ALLOW');
    expect(evaluate('mission-2').decision).toBe('ASK');

    store.savePermissionRule(rule('MISSION', 'mission-1', 'DENY'));
    expect(evaluate('mission-1').decision).toBe('DENY');
    expect(evaluate('mission-1').matchedRuleIds).toHaveLength(3);
  });

  it('honors exact resource matching and supports a bounded wildcard', () => {
    const store = new RuleStore();
    store.savePermissionRule(rule('GLOBAL', null, 'ALLOW', 'mission:fixture:*'));
    const engine = new PermissionEngine(store);
    const evaluate = (resource: string) =>
      engine.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'teammate-1',
        capability: 'SPEND_BUDGET',
        resource,
        teammateId: 'teammate-1',
        missionId: 'mission-1',
      }).decision;
    expect(evaluate('mission:fixture:small')).toBe('ALLOW');
    expect(evaluate('mission:file:read')).toBe('ASK');
  });
});
