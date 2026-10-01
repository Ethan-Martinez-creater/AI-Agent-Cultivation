import { DomainError } from '@cultivation/shared';
import type { WorkflowArtifactKind, WorkflowArtifactSpec, WorkflowVersion } from './w1-workflow.js';

export type WorkflowInputValue =
  | string
  | number
  | boolean
  | WorkflowInputValue[]
  | { [key: string]: WorkflowInputValue };
export type WorkflowInputs = Record<string, WorkflowInputValue>;
type FieldMetadata = { title?: string; description?: string };
export type WorkflowValueSchema = FieldMetadata &
  (
    | { type: 'string'; minLength: number; maxLength: number }
    | { type: 'number'; minimum: number; maximum: number; integer?: boolean }
    | { type: 'boolean' }
    | { type: 'enum'; values: string[] }
    | { type: 'array'; items: WorkflowValueSchema; minItems: number; maxItems: number }
    | WorkflowObjectSchema
    | { type: 'date'; minDate?: string; maxDate?: string }
    | { type: 'dateRange'; minDate?: string; maxDate?: string }
    | { type: 'artifactRef'; allowedKinds: WorkflowArtifactKind[] }
  );
export interface WorkflowObjectSchema {
  type: 'object';
  properties: Record<string, WorkflowValueSchema>;
  required: string[];
  title?: string;
  description?: string;
}
export interface WorkflowFinalOutputSpec extends WorkflowArtifactSpec {
  fromStepId: string;
  outputKey: string;
}
export interface WorkflowOutputSchema {
  outputs: WorkflowFinalOutputSpec[];
}
export interface WorkflowFinalValidation {
  id: string;
  workflowRunId: string;
  definitionVersion: number;
  inputHash: string;
  stateHash: string;
  outputBindings: Array<{ key: string; artifactId: string; contentHash: string }>;
  valid: boolean;
  errors: string[];
  createdAt: string;
}
export const W1_INPUT_POLICY = {
  version: 'w1-io-v1',
  maxDepth: 4,
  maxSchemaFields: 64,
  maxObjectFields: 16,
  maxArrayItems: 20,
  maxStringLength: 4000,
  maxSnapshotBytes: 32768,
  maxStepDataBytes: 8000,
} as const;
export const EMPTY_WORKFLOW_INPUT_SCHEMA: WorkflowObjectSchema = {
  type: 'object',
  properties: {},
  required: [],
};
const kinds: WorkflowArtifactKind[] = ['TEXT', 'JSON', 'FILE', 'DIRECTORY', 'EXTERNAL_REFERENCE'];
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function plainSchema(value: unknown): boolean {
  return plain(value);
}
function invalid(message: string): never {
  throw new DomainError('WORKFLOW_INPUT_INVALID', message);
}
function schemaInvalid(): never {
  throw new DomainError('INVALID_INPUT', 'Workflow I/O schema 无效或超出限制');
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Closed, bounded schema subset. There are no executable expressions or file access grants. */
export function validateWorkflowInputSchema(root: WorkflowObjectSchema): void {
  let fields = 0;
  const visit = (schema: WorkflowValueSchema, depth: number): void => {
    if (
      !plainSchema(schema) ||
      depth > W1_INPUT_POLICY.maxDepth ||
      ++fields > W1_INPUT_POLICY.maxSchemaFields
    )
      schemaInvalid();
    if (
      (schema.title !== undefined &&
        (typeof schema.title !== 'string' || schema.title.length > 80)) ||
      (schema.description !== undefined &&
        (typeof schema.description !== 'string' || schema.description.length > 300))
    )
      schemaInvalid();
    let ownKeys: string[] = [];
    switch (schema.type) {
      case 'string':
        ownKeys = ['minLength', 'maxLength'];
        if (
          !Number.isSafeInteger(schema.minLength) ||
          !Number.isSafeInteger(schema.maxLength) ||
          schema.minLength < 0 ||
          schema.maxLength < schema.minLength ||
          schema.maxLength > W1_INPUT_POLICY.maxStringLength
        )
          schemaInvalid();
        break;
      case 'number':
        ownKeys = ['minimum', 'maximum', 'integer'];
        if (
          !Number.isFinite(schema.minimum) ||
          !Number.isFinite(schema.maximum) ||
          schema.maximum < schema.minimum ||
          (schema.integer !== undefined && typeof schema.integer !== 'boolean')
        )
          schemaInvalid();
        break;
      case 'boolean':
        break;
      case 'enum':
        ownKeys = ['values'];
        if (
          !Array.isArray(schema.values) ||
          schema.values.length < 1 ||
          schema.values.length > 20 ||
          new Set(schema.values).size !== schema.values.length ||
          schema.values.some((v) => typeof v !== 'string' || !v || v.length > 128)
        )
          schemaInvalid();
        break;
      case 'array':
        ownKeys = ['items', 'minItems', 'maxItems'];
        if (
          !Number.isSafeInteger(schema.minItems) ||
          !Number.isSafeInteger(schema.maxItems) ||
          schema.minItems < 0 ||
          schema.maxItems < schema.minItems ||
          schema.maxItems > W1_INPUT_POLICY.maxArrayItems
        )
          schemaInvalid();
        visit(schema.items, depth + 1);
        break;
      case 'object':
        ownKeys = ['properties', 'required'];
        if (
          !plain(schema.properties) ||
          Object.keys(schema.properties).length > W1_INPUT_POLICY.maxObjectFields ||
          !Array.isArray(schema.required) ||
          new Set(schema.required).size !== schema.required.length ||
          schema.required.some((k) => !Object.hasOwn(schema.properties, k))
        )
          schemaInvalid();
        for (const [key, child] of Object.entries(schema.properties)) {
          if (!keyPattern.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))
            schemaInvalid();
          visit(child, depth + 1);
        }
        break;
      case 'date':
      case 'dateRange':
        ownKeys = ['minDate', 'maxDate'];
        if (
          (schema.minDate !== undefined && !validDate(schema.minDate)) ||
          (schema.maxDate !== undefined && !validDate(schema.maxDate)) ||
          (schema.minDate && schema.maxDate && schema.minDate > schema.maxDate)
        )
          schemaInvalid();
        break;
      case 'artifactRef':
        ownKeys = ['allowedKinds'];
        if (
          !Array.isArray(schema.allowedKinds) ||
          !schema.allowedKinds.length ||
          schema.allowedKinds.length > kinds.length ||
          new Set(schema.allowedKinds).size !== schema.allowedKinds.length ||
          schema.allowedKinds.some((k) => !kinds.includes(k))
        )
          schemaInvalid();
        break;
      default:
        schemaInvalid();
    }
    if (
      Object.keys(schema).some((key) => !['type', 'title', 'description', ...ownKeys].includes(key))
    )
      schemaInvalid();
  };
  if (root?.type !== 'object') schemaInvalid();
  visit(root, 0);
}
export function validateWorkflowInputs(
  schema: WorkflowObjectSchema,
  value: unknown,
): WorkflowInputs {
  validateWorkflowInputSchema(schema);
  const visit = (field: WorkflowValueSchema, data: unknown, path: string): void => {
    const fail = () => invalid(`输入 ${path} 不符合冻结版本的约定`);
    switch (field.type) {
      case 'string':
        if (
          typeof data !== 'string' ||
          data.length < field.minLength ||
          data.length > field.maxLength
        )
          fail();
        break;
      case 'number':
        if (
          typeof data !== 'number' ||
          !Number.isFinite(data) ||
          data < field.minimum ||
          data > field.maximum ||
          (field.integer && !Number.isSafeInteger(data))
        )
          fail();
        break;
      case 'boolean':
        if (typeof data !== 'boolean') fail();
        break;
      case 'enum':
        if (typeof data !== 'string' || !field.values.includes(data)) fail();
        break;
      case 'array':
        if (!Array.isArray(data) || data.length < field.minItems || data.length > field.maxItems)
          fail();
        (data as unknown[]).forEach((item, i) => visit(field.items, item, `${path}[${i}]`));
        break;
      case 'object':
        if (!plain(data)) fail();
        for (const key of Object.keys(data as object))
          if (!Object.hasOwn(field.properties, key)) invalid(`输入 ${path} 包含未声明字段`);
        for (const key of field.required)
          if (!Object.hasOwn(data as object, key)) invalid(`缺少必填输入 ${path}.${key}`);
        for (const [key, child] of Object.entries(field.properties))
          if (Object.hasOwn(data as object, key))
            visit(child, (data as Record<string, unknown>)[key], `${path}.${key}`);
        break;
      case 'date':
      case 'dateRange': {
        const dates =
          field.type === 'date'
            ? [data]
            : plain(data) &&
                Object.keys(data).length === 2 &&
                Object.hasOwn(data, 'start') &&
                Object.hasOwn(data, 'end')
              ? [data.start, data.end]
              : [];
        if (
          !dates.length ||
          dates.some(
            (d) =>
              !validDate(d) ||
              (field.minDate && d < field.minDate) ||
              (field.maxDate && d > field.maxDate),
          ) ||
          (field.type === 'dateRange' && String(dates[0]) > String(dates[1]))
        )
          fail();
        break;
      }
      case 'artifactRef':
        if (
          !plain(data) ||
          Object.keys(data).some((k) => !['id', 'kind', 'name', 'contentHash'].includes(k)) ||
          typeof data.id !== 'string' ||
          !data.id.trim() ||
          data.id.length > 128 ||
          !field.allowedKinds.includes(data.kind as WorkflowArtifactKind) ||
          (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 256)) ||
          (data.contentHash !== undefined &&
            (typeof data.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.contentHash)))
        )
          fail();
        break;
    }
  };
  visit(schema, value, 'workflow');
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > W1_INPUT_POLICY.maxSnapshotBytes)
    invalid('Workflow 输入超过总大小限制');
  return JSON.parse(encoded) as WorkflowInputs;
}
/** Explicit top-level allowlist only; this returns data, never instructions or authority. */
export function workflowInputsForStep(
  version: WorkflowVersion,
  snapshot: WorkflowInputs,
  stepId: string,
): WorkflowInputs {
  const step = version.steps.find((s) => s.id === stepId);
  const result = Object.fromEntries(
    (step?.workflowInputKeys ?? [])
      .filter((k) => Object.hasOwn(snapshot, k))
      .map((k) => [k, snapshot[k]!]),
  );
  if (new TextEncoder().encode(JSON.stringify(result)).length > W1_INPUT_POLICY.maxStepDataBytes)
    invalid('Step 声明的输入超过模型上下文限制');
  return JSON.parse(JSON.stringify(result)) as WorkflowInputs;
}
