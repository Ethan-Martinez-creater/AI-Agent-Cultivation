import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  W1_INPUT_POLICY,
  type WorkflowDetail,
  type WorkflowInputs,
  type WorkflowRun,
  type WorkflowVersion,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';

const workflowId = z.string().trim().min(1).max(128);
const versionNumber = z.number().int().min(1).max(10_000);
const workflowInputKey = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedWorkflowInputs(value: unknown): value is WorkflowInputs {
  if (!isPlainRecord(value) || Object.keys(value).length > W1_INPUT_POLICY.maxObjectFields)
    return false;
  const active = new WeakSet<object>();
  const visit = (current: unknown, depth: number): boolean => {
    // Date ranges and opaque references contain bounded scalar metadata one level
    // below their schema node. The application still validates the exact schema.
    if (depth > W1_INPUT_POLICY.maxDepth + 1) return false;
    if (typeof current === 'string') return current.length <= W1_INPUT_POLICY.maxStringLength;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current === 'boolean') return true;
    if (Array.isArray(current)) {
      if (current.length > W1_INPUT_POLICY.maxArrayItems || active.has(current)) return false;
      const keys = Reflect.ownKeys(current);
      if (
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= current.length),
        )
      )
        return false;
      active.add(current);
      let valid = true;
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !visit(descriptor.value, depth + 1)
        ) {
          valid = false;
          break;
        }
      }
      active.delete(current);
      return valid;
    }
    if (
      !isPlainRecord(current) ||
      Object.keys(current).length > W1_INPUT_POLICY.maxObjectFields ||
      active.has(current)
    )
      return false;
    const ownKeys = Reflect.ownKeys(current);
    if (
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !workflowInputKey.test(key) ||
          ['constructor', 'prototype', '__proto__'].includes(key),
      )
    )
      return false;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    }
    active.add(current);
    const valid = ownKeys.every((key) =>
      visit((current as Record<string, unknown>)[key as string], depth + 1),
    );
    active.delete(current);
    return valid;
  };
  if (!visit(value, 0)) return false;
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <= W1_INPUT_POLICY.maxSnapshotBytes
    );
  } catch {
    return false;
  }
}

const workflowInputs = z.custom<WorkflowInputs>(isBoundedWorkflowInputs);
const createRunInput = z
  .object({
    definitionId: workflowId,
    version: versionNumber,
    inputs: workflowInputs.optional(),
  })
  .strict();

function publicWorkflowInputError(error: DomainError): DomainError {
  const missing = /^缺少必填输入 ([A-Za-z][A-Za-z0-9_.[\]]{0,255})$/.exec(error.message);
  const invalid = /^输入 ([A-Za-z][A-Za-z0-9_.[\]]{0,255}) 不符合冻结版本的约定$/.exec(
    error.message,
  );
  const undeclared = /^输入 ([A-Za-z][A-Za-z0-9_.[\]]{0,255}) 包含未声明字段$/.exec(error.message);
  const field = missing?.[1] ?? invalid?.[1] ?? undeclared?.[1];
  return new DomainError(
    'WORKFLOW_INPUT_INVALID',
    field
      ? `工作流输入字段 ${field} 无效，请检查该字段后重试`
      : '工作流输入无效，请检查必填项、格式和范围后重试',
  );
}

/** Structural boundary so Main can compose the concrete application service. */
export interface WorkflowServicePort {
  listVersions(): WorkflowVersion[];
  listRuns(): WorkflowRun[];
  detail(runId: string): WorkflowDetail;
  createRun(input: {
    definitionId: string;
    version: number;
    inputs?: WorkflowInputs;
  }): WorkflowDetail;
  advance(runId: string): Promise<WorkflowDetail>;
  retryMission(runId: string): Promise<WorkflowDetail>;
  retryStep(runId: string): WorkflowDetail;
  pause(runId: string): WorkflowDetail;
  resume(runId: string): Promise<WorkflowDetail>;
  cancel(runId: string): WorkflowDetail;
}

export function registerWorkflowIpc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: WorkflowServicePort,
): void {
  const register = (
    channel: string,
    parse: (args: unknown[]) => unknown,
    handle: (value: unknown) => unknown | Promise<unknown>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      let value: unknown;
      try {
        value = parse(args);
      } catch {
        throw new Error('请求参数无效');
      }
      try {
        return await handle(value);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'WORKFLOW_INPUT_INVALID') {
          throw publicWorkflowInputError(error);
        }
        throw new Error('工作流操作失败，请检查运行状态后重试');
      }
    });
  };
  const noArgs = (args: unknown[]) => z.tuple([]).parse(args);
  const withId = (args: unknown[]) => z.tuple([workflowId]).parse(args)[0];

  register('workflows:versions', noArgs, () => service.listVersions());
  register('workflows:list', noArgs, () => service.listRuns());
  register(
    'workflows:detail',
    (args) => withId(args),
    (id) => service.detail(id as string),
  );
  register(
    'workflows:create',
    (args) => z.tuple([createRunInput]).parse(args)[0],
    (input) =>
      service.createRun(
        input as { definitionId: string; version: number; inputs?: WorkflowInputs },
      ),
  );
  register(
    'workflows:advance',
    (args) => withId(args),
    (id) => service.advance(id as string),
  );
  register(
    'workflows:retryMission',
    (args) => withId(args),
    (id) => service.retryMission(id as string),
  );
  register(
    'workflows:retryStep',
    (args) => withId(args),
    (id) => service.retryStep(id as string),
  );
  register(
    'workflows:pause',
    (args) => withId(args),
    (id) => service.pause(id as string),
  );
  register(
    'workflows:resume',
    (args) => withId(args),
    (id) => service.resume(id as string),
  );
  register(
    'workflows:cancel',
    (args) => withId(args),
    (id) => service.cancel(id as string),
  );
}
