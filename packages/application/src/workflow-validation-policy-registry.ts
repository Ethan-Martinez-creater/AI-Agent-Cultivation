import { DomainError } from '@cultivation/shared';
import type { WorkflowValidationPolicyPort } from './w1-workflow-service.js';

/** Trusted application composition only. No persistence or IPC accepts executable policies. */
export class WorkflowValidationPolicyRegistry {
  private readonly policies = new Map<string, WorkflowValidationPolicyPort>();
  register(id: string, policy: WorkflowValidationPolicyPort): void {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(id) || this.policies.has(id))
      throw new DomainError('INVALID_INPUT', '无效或重复的工作流校验策略');
    this.policies.set(id, Object.freeze({ ...policy }));
  }
  require(id: string): WorkflowValidationPolicyPort {
    const policy = this.policies.get(id);
    if (!policy)
      throw new DomainError(
        'WORKFLOW_VALIDATION_POLICY_REQUIRED',
        '冻结 Workflow validation policy 不可用；必须 fail closed',
      );
    return policy;
  }
}
