import { describe, it, expect } from 'vitest';
import { WorkflowValidationPolicyRegistry } from './workflow-validation-policy-registry.js';

describe('trusted Workflow validation policy registry', () => {
  it('dispatches registered official policies independently of the news ID', () => {
    const registry = new WorkflowValidationPolicyRegistry();
    const policy = { validateInputs: () => undefined, validateStep: () => ['bounded-result'] };
    registry.register('future-official-v1', policy);
    expect(registry.require('future-official-v1').validateStep).toBe(policy.validateStep);
    expect(Object.isFrozen(registry.require('future-official-v1'))).toBe(true);
    expect(() => registry.register('future-official-v1', policy)).toThrow();
  });
  it('fails closed for unknown or unbounded IDs', () => {
    const registry = new WorkflowValidationPolicyRegistry();
    expect(() => registry.require('unknown-v1')).toThrow();
    expect(() =>
      registry.register('../code', { validateInputs: () => undefined, validateStep: () => [] }),
    ).toThrow();
  });
});
