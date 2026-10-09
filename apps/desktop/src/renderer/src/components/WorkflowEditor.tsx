import React, { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowArtifactKind,
  WorkflowDraft,
  WorkflowDraftContent,
  WorkflowStepType,
  WorkflowVersion,
  WorkflowValueSchema,
} from '@cultivation/domain';
import { W1_INPUT_POLICY } from '@cultivation/domain';
import type { CultivationBridge } from '../../../preload/preload.js';
import { Button } from './Button.js';
import { Section } from './Section.js';
import { StatusBadge } from './StatusBadge.js';
import { CapabilityPicker } from '../r4-routing.js';
import './WorkflowEditor.css';

export type WorkflowEditorApi = Pick<
  CultivationBridge['workflowEditor'],
  'saveDraft' | 'reorderDraft' | 'publishDraft'
>;

type DraftStep = WorkflowDraftContent['steps'][number];
type DraftEdge = WorkflowDraftContent['edges'][number];
type DraftOutput = DraftStep['outputs'][number];

const STEP_TYPES: Array<[WorkflowStepType, string]> = [
  ['TASK', '任务'],
  ['REVIEW', '审核'],
  ['DECISION', '决策'],
];
const ARTIFACT_KINDS: Array<[WorkflowArtifactKind, string]> = [
  ['TEXT', '文本'],
  ['JSON', 'JSON'],
  ['FILE', '文件'],
  ['DIRECTORY', '目录'],
  ['EXTERNAL_REFERENCE', '外部引用'],
];
const EXECUTION_CONSTRAINTS = [
  ['AUTO', '自动分配'],
  ['SOLO', '单人执行'],
  ['PARTY', '协作执行'],
  ['HUMAN_BRIDGE', '本尊执行'],
] as const;
const MAX_OUTPUT_SIZE = 1_000_000;
const MAX_TEXT_OUTPUT_LENGTH = 100_000;
const REVIEW_REQUIRED_KEYS = ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'];

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function createTextOutput(key = 'result', description = '步骤生成的文本交付'): DraftOutput {
  return {
    key,
    kind: 'TEXT',
    required: true,
    contractId: 'user.text-result',
    contractVersion: '1',
    maxSizeBytes: 16_384,
    description,
    validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
  };
}

function createReviewOutput(): DraftOutput {
  return {
    key: 'review',
    kind: 'JSON',
    required: true,
    contractId: 'user.review-verdict',
    contractVersion: '1',
    maxSizeBytes: 8_192,
    description: '结构化审核结论，包含结论、发现、证据和摘要。',
    validator: { type: 'JSON', requiredKeys: [...REVIEW_REQUIRED_KEYS] },
  };
}

function createStep(type: WorkflowStepType, index: number): DraftStep {
  const stepId = id('step');
  return {
    id: stepId,
    type,
    title:
      type === 'REVIEW'
        ? `审核步骤 ${index + 1}`
        : type === 'DECISION'
          ? `决策步骤 ${index + 1}`
          : `任务步骤 ${index + 1}`,
    objective:
      type === 'REVIEW'
        ? '检查输入交付，输出 PASS、REVISE 或 FAIL 的结构化结论。'
        : type === 'DECISION'
          ? '根据已声明的 JSON 输入字段选择一个已声明分支。'
          : '完成本步骤目标，并提交符合输出约定的交付。',
    routing: {
      requiredCapabilities: ['GENERAL_REASONING'],
      executionConstraint: 'SOLO',
    },
    inputs: [],
    workflowInputKeys: [],
    outputs:
      type === 'REVIEW' ? [createReviewOutput()] : type === 'DECISION' ? [] : [createTextOutput()],
    ...(type === 'REVIEW' ? { reviewOutputKey: 'review' } : {}),
    maxAttempts: 1,
    exitCondition: 'VALID_OUTPUTS',
  };
}

function edge(
  fromStepId: string,
  toStepId: string | null,
  branch: string,
  condition: DraftEdge['condition'],
): DraftEdge {
  return { id: id('edge'), fromStepId, toStepId, branch, condition };
}

export function createDefaultWorkflowDraftContent(): WorkflowDraftContent {
  const step = createStep('TASK', 0);
  return {
    name: '新建工作流',
    description: '',
    category: '个人工作流',
    inputSchema: { type: 'object', properties: {}, required: [] },
    finalOutputs: [
      {
        key: 'result',
        fromStepId: step.id,
        outputKey: 'result',
        required: true,
        description: '最终文本结果',
      },
    ],
    entryStepId: step.id,
    steps: [step],
    edges: [edge(step.id, null, '完成', { type: 'ALWAYS' })],
  };
}

function safeError(error: unknown, fallback: string): string {
  const message =
    error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return typeof message === 'string' && message.trim() ? message.slice(0, 1_200) : fallback;
}

function withTerminalStep(content: WorkflowDraftContent, step: DraftStep): WorkflowDraftContent {
  const terminalEdges = content.edges.filter((item) => item.toStepId === null);
  const edges = content.edges.map((item) =>
    item.toStepId === null ? { ...item, toStepId: step.id } : item,
  );
  if (terminalEdges.length === 0 && content.steps.length > 0) {
    const previous = content.steps.at(-1)!;
    edges.push(edge(previous.id, step.id, '继续', { type: 'ALWAYS' }));
  }
  edges.push(edge(step.id, null, '完成', { type: 'ALWAYS' }));
  return {
    ...content,
    entryStepId: content.entryStepId || step.id,
    steps: [...content.steps, step],
    edges,
  };
}

function outputOf(step: DraftStep | undefined, key: string): DraftOutput | undefined {
  return step?.outputs.find((output) => output.key === key);
}

function appendReview(content: WorkflowDraftContent): WorkflowDraftContent {
  const source = [...content.steps].reverse().find((step) => step.type === 'TASK');
  const review = createStep('REVIEW', content.steps.length);
  if (source) {
    const output = source.outputs.find((item) => item.required) ?? source.outputs[0];
    if (output)
      review.inputs = [
        { key: 'reviewInput', fromStepId: source.id, outputKey: output.key, required: true },
      ];
  }
  const revision = createStep('TASK', content.steps.length + 1);
  revision.title = '按审核意见修改';
  revision.objective = '根据审核步骤提供的修改意见完善交付，并提交修订结果。';
  if (review.outputs[0]) {
    revision.inputs = [
      {
        key: 'reviewFeedback',
        fromStepId: review.id,
        outputKey: review.outputs[0].key,
        required: true,
      },
    ];
  }

  const terminalEdges = content.edges.filter((item) => item.toStepId === null);
  const edges = content.edges.map((item) =>
    item.toStepId === null ? { ...item, toStepId: review.id } : item,
  );
  if (terminalEdges.length === 0 && content.steps.length > 0) {
    edges.push(edge(content.steps.at(-1)!.id, review.id, '审核', { type: 'ALWAYS' }));
  }
  edges.push(
    edge(review.id, null, '通过', { type: 'REVIEW_VERDICT', verdict: 'PASS' }),
    edge(review.id, revision.id, '修改', { type: 'REVIEW_VERDICT', verdict: 'REVISE' }),
    edge(review.id, null, '未通过', { type: 'REVIEW_VERDICT', verdict: 'FAIL' }),
    edge(revision.id, null, '完成', { type: 'ALWAYS' }),
  );
  return {
    ...content,
    steps: [...content.steps, review, revision],
    edges,
    finalOutputs: [
      ...content.finalOutputs,
      {
        key: 'revision',
        fromStepId: revision.id,
        outputKey: 'result',
        required: false,
        description: '审核修改路径的修订结果',
      },
    ],
  };
}

function createDefaultSchemaValue(type: WorkflowValueSchema['type']): WorkflowValueSchema {
  switch (type) {
    case 'string':
      return { type, minLength: 0, maxLength: 1_000 };
    case 'number':
      return { type, minimum: 0, maximum: 1_000 };
    case 'boolean':
      return { type };
    case 'enum':
      return { type, values: ['option_a', 'option_b'] };
    case 'array':
      return {
        type,
        items: { type: 'string', minLength: 0, maxLength: 1_000 },
        minItems: 0,
        maxItems: 20,
      };
    case 'object':
      return { type, properties: {}, required: [] };
    case 'date':
    case 'dateRange':
      return { type };
    case 'artifactRef':
      return { type, allowedKinds: ['TEXT', 'JSON'] };
  }
}

function fieldName(base: string, properties: Record<string, WorkflowValueSchema>): string {
  let next = base;
  let suffix = 2;
  while (Object.hasOwn(properties, next)) next = `${base}_${suffix++}`;
  return next;
}

function schemaFieldCount(schema: WorkflowValueSchema): number {
  if (schema.type === 'object')
    return Object.values(schema.properties).reduce(
      (sum, child) => sum + 1 + schemaFieldCount(child),
      0,
    );
  if (schema.type === 'array') return schemaFieldCount(schema.items);
  return 0;
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`workflow-editor-field ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function SchemaFieldsEditor({
  schema,
  fullSchema = schema,
  onChange,
  depth = 0,
  prefix = '输入字段',
}: {
  schema: Extract<WorkflowValueSchema, { type: 'object' }>;
  fullSchema?: WorkflowValueSchema;
  onChange: (next: Extract<WorkflowValueSchema, { type: 'object' }>) => void;
  depth?: number;
  prefix?: string;
}) {
  const updateProperty = (key: string, value: WorkflowValueSchema) =>
    onChange({ ...schema, properties: { ...schema.properties, [key]: value } });
  const renameProperty = (key: string, nextKey: string) => {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([propertyKey, value]) => [
        propertyKey === key ? nextKey : propertyKey,
        value,
      ]),
    );
    onChange({
      ...schema,
      properties,
      required: schema.required.map((item) => (item === key ? nextKey : item)),
    });
  };
  const deleteProperty = (key: string) => {
    const properties = { ...schema.properties };
    delete properties[key];
    onChange({
      ...schema,
      properties,
      required: schema.required.filter((item) => item !== key),
    });
  };
  const toggleRequired = (key: string, required: boolean) =>
    onChange({
      ...schema,
      required: required
        ? [...new Set([...schema.required, key])]
        : schema.required.filter((item) => item !== key),
    });

  return (
    <div className="workflow-schema-fields" data-schema-depth={depth}>
      <div className="workflow-editor-grid">
        <Field label={depth === 0 ? '输入约定名称' : '对象名称'}>
          <input
            value={schema.title ?? ''}
            maxLength={80}
            onChange={(event) => onChange({ ...schema, title: event.target.value })}
          />
        </Field>
        <Field label="输入说明">
          <input
            value={schema.description ?? ''}
            maxLength={300}
            onChange={(event) => onChange({ ...schema, description: event.target.value })}
          />
        </Field>
      </div>
      <div className="workflow-schema-field-list">
        {Object.entries(schema.properties).map(([key, value], index) => (
          <fieldset className="workflow-schema-field" key={index}>
            <legend>{value.title || key || `字段 ${index + 1}`}</legend>
            <div className="workflow-editor-grid">
              <Field label="字段键">
                <input
                  value={key}
                  maxLength={64}
                  aria-label={`${prefix} ${index + 1} 字段键`}
                  data-testid="workflow-input-schema-field-key"
                  onChange={(event) => {
                    const nextKey = event.target.value.trim();
                    if (nextKey && nextKey !== key && !Object.hasOwn(schema.properties, nextKey))
                      renameProperty(key, nextKey);
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.value.trim()) return;
                    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event.currentTarget.value))
                      event.currentTarget.setCustomValidity(
                        '字段键需以英文字母开头，只能包含字母、数字和下划线。',
                      );
                    else event.currentTarget.setCustomValidity('');
                  }}
                />
              </Field>
              <label className="workflow-editor-checkbox">
                <input
                  type="checkbox"
                  checked={schema.required.includes(key)}
                  aria-label={`${prefix} ${index + 1} 必填`}
                  onChange={(event) => toggleRequired(key, event.target.checked)}
                />
                <span>必填</span>
              </label>
              <Button
                variant="ghost"
                className="small"
                aria-label={`删除${prefix} ${key}`}
                onClick={() => deleteProperty(key)}
              >
                删除字段
              </Button>
            </div>
            <SchemaValueEditor
              value={value}
              label={`${prefix} ${index + 1}`}
              depth={depth + 1}
              fullSchema={fullSchema}
              onChange={(next) => updateProperty(key, next)}
            />
          </fieldset>
        ))}
      </div>
      <Button
        variant="secondary"
        className="small"
        disabled={
          depth >= W1_INPUT_POLICY.maxDepth ||
          Object.keys(schema.properties).length >= W1_INPUT_POLICY.maxObjectFields ||
          schemaFieldCount(fullSchema) + 1 >= W1_INPUT_POLICY.maxSchemaFields
        }
        data-testid={depth === 0 ? 'workflow-input-schema-add' : undefined}
        onClick={() => {
          const key = fieldName('field', schema.properties);
          onChange({
            ...schema,
            properties: {
              ...schema.properties,
              [key]: { type: 'string', minLength: 0, maxLength: 1_000, title: '新输入' },
            },
          });
        }}
      >
        {depth === 0 ? '添加输入字段' : '添加对象字段'}
      </Button>
    </div>
  );
}

function SchemaValueEditor({
  value,
  label,
  depth,
  fullSchema,
  onChange,
}: {
  value: WorkflowValueSchema;
  label: string;
  depth: number;
  fullSchema: WorkflowValueSchema;
  onChange: (next: WorkflowValueSchema) => void;
}) {
  const update = (changes: Partial<WorkflowValueSchema>) =>
    onChange({ ...value, ...changes } as WorkflowValueSchema);
  const changeType = (type: WorkflowValueSchema['type']) => {
    const next = createDefaultSchemaValue(type);
    onChange({
      ...next,
      title: value.title,
      description: value.description,
    } as WorkflowValueSchema);
  };
  return (
    <div className="workflow-schema-value">
      <div className="workflow-editor-grid">
        <Field label="显示名称">
          <input
            value={value.title ?? ''}
            maxLength={80}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field label="字段说明">
          <input
            value={value.description ?? ''}
            maxLength={300}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>
        <Field label="数据类型">
          <select
            value={value.type}
            aria-label={`${label}数据类型`}
            onChange={(event) => changeType(event.target.value as WorkflowValueSchema['type'])}
          >
            <option value="string">文本</option>
            <option value="number">数字</option>
            <option value="boolean">是 / 否</option>
            <option value="enum">枚举选项</option>
            <option value="date">日期</option>
            <option value="dateRange">日期范围</option>
            <option value="array">列表</option>
            <option value="object">对象</option>
            <option value="artifactRef">已有交付引用</option>
          </select>
        </Field>
      </div>
      {value.type === 'string' && (
        <div className="workflow-editor-grid">
          <NumberField
            label="最少字符"
            value={value.minLength}
            min={0}
            max={W1_INPUT_POLICY.maxStringLength}
            onChange={(next) => update({ minLength: next } as Partial<WorkflowValueSchema>)}
          />
          <NumberField
            label="最多字符"
            value={value.maxLength}
            min={0}
            max={W1_INPUT_POLICY.maxStringLength}
            onChange={(next) => update({ maxLength: next } as Partial<WorkflowValueSchema>)}
          />
        </div>
      )}
      {value.type === 'number' && (
        <div className="workflow-editor-grid">
          <NumberField
            label="最小值"
            value={value.minimum}
            min={-Number.MAX_VALUE}
            max={Number.MAX_VALUE}
            onChange={(next) => update({ minimum: next } as Partial<WorkflowValueSchema>)}
          />
          <NumberField
            label="最大值"
            value={value.maximum}
            min={-Number.MAX_VALUE}
            max={Number.MAX_VALUE}
            onChange={(next) => update({ maximum: next } as Partial<WorkflowValueSchema>)}
          />
          <label className="workflow-editor-checkbox">
            <input
              type="checkbox"
              checked={value.integer ?? false}
              onChange={(event) =>
                update({ integer: event.target.checked } as Partial<WorkflowValueSchema>)
              }
            />
            <span>只接受整数</span>
          </label>
        </div>
      )}
      {value.type === 'enum' && (
        <Field label="可选值（每行一项）">
          <textarea
            rows={3}
            value={value.values.join('\n')}
            onChange={(event) =>
              update({
                values: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 20)
                  .map((item) => item.slice(0, 128)),
              } as Partial<WorkflowValueSchema>)
            }
          />
        </Field>
      )}
      {(value.type === 'date' || value.type === 'dateRange') && (
        <div className="workflow-editor-grid">
          <Field label="最早日期">
            <input
              type="date"
              value={value.minDate ?? ''}
              onChange={(event) =>
                update({ minDate: event.target.value || undefined } as Partial<WorkflowValueSchema>)
              }
            />
          </Field>
          <Field label="最晚日期">
            <input
              type="date"
              value={value.maxDate ?? ''}
              onChange={(event) =>
                update({ maxDate: event.target.value || undefined } as Partial<WorkflowValueSchema>)
              }
            />
          </Field>
        </div>
      )}
      {value.type === 'array' && (
        <div className="workflow-schema-nested">
          <div className="workflow-editor-grid">
            <NumberField
              label="最少项目"
              value={value.minItems}
              min={0}
              max={20}
              onChange={(next) => update({ minItems: next } as Partial<WorkflowValueSchema>)}
            />
            <NumberField
              label="最多项目"
              value={value.maxItems}
              min={0}
              max={W1_INPUT_POLICY.maxArrayItems}
              onChange={(next) => update({ maxItems: next } as Partial<WorkflowValueSchema>)}
            />
          </div>
          <SchemaValueEditor
            value={value.items}
            label={`${label}列表项`}
            depth={depth + 1}
            fullSchema={fullSchema}
            onChange={(items) => update({ items } as Partial<WorkflowValueSchema>)}
          />
        </div>
      )}
      {value.type === 'object' && (
        <div className="workflow-schema-nested">
          <SchemaFieldsEditor
            schema={value}
            depth={depth}
            prefix={label}
            fullSchema={fullSchema}
            onChange={(next) => onChange(next)}
          />
        </div>
      )}
      {value.type === 'artifactRef' && (
        <fieldset className="workflow-editor-choice-list">
          <legend>允许引用的交付类型</legend>
          {ARTIFACT_KINDS.map(([kind, name]) => (
            <label className="workflow-editor-checkbox" key={kind}>
              <input
                type="checkbox"
                checked={value.allowedKinds.includes(kind)}
                onChange={(event) =>
                  update({
                    allowedKinds: event.target.checked
                      ? [...new Set([...value.allowedKinds, kind])]
                      : value.allowedKinds.filter((item) => item !== kind),
                  } as Partial<WorkflowValueSchema>)
                }
              />
              <span>{name}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) =>
          onChange(Math.max(min, Math.min(max, numberValue(event.target.value, value))))
        }
      />
    </Field>
  );
}

function WorkflowInputSchemaEditor({
  schema,
  onChange,
}: {
  schema: WorkflowDraftContent['inputSchema'];
  onChange: (next: WorkflowDraftContent['inputSchema']) => void;
}) {
  return (
    <SchemaFieldsEditor
      schema={schema}
      fullSchema={schema}
      onChange={(next) => onChange(next as WorkflowDraftContent['inputSchema'])}
    />
  );
}

export function updateWorkflowDraftInputSchema(
  content: WorkflowDraftContent,
  inputSchema: WorkflowDraftContent['inputSchema'],
): WorkflowDraftContent {
  const currentKeys = Object.keys(content.inputSchema.properties);
  const nextKeys = Object.keys(inputSchema.properties);
  const removedKeys = currentKeys.filter((key) => !nextKeys.includes(key));
  const addedKeys = nextKeys.filter((key) => !currentKeys.includes(key));
  if (removedKeys.length !== 1 || addedKeys.length !== 1) return { ...content, inputSchema };

  const [removedKey] = removedKeys;
  const [addedKey] = addedKeys;
  return {
    ...content,
    inputSchema,
    steps: content.steps.map((step) => {
      const workflowInputKeys = step.workflowInputKeys ?? [];
      if (!workflowInputKeys.includes(removedKey!)) return step;
      return {
        ...step,
        workflowInputKeys: [
          ...new Set(workflowInputKeys.map((key) => (key === removedKey ? addedKey! : key))),
        ],
      };
    }),
  };
}

function outputChoices(steps: DraftStep[]) {
  return steps.flatMap((step) =>
    step.outputs.map((output) => ({
      step,
      output,
      value: `${step.id}::${output.key}`,
      label: `${step.title} · ${output.key} · ${output.kind}`,
    })),
  );
}

function InputBindingsEditor({
  step,
  index,
  content,
  onChange,
}: {
  step: DraftStep;
  index: number;
  content: WorkflowDraftContent;
  onChange: (inputs: DraftStep['inputs'], workflowInputKeys: string[]) => void;
}) {
  const upstream = content.steps.slice(0, index);
  const choices = outputChoices(upstream);
  const workflowInputKeys = step.workflowInputKeys ?? [];
  const inputKeys = Object.keys(content.inputSchema.properties);
  const updateBinding = (bindingIndex: number, update: Partial<DraftStep['inputs'][number]>) =>
    onChange(
      step.inputs.map((binding, current) =>
        current === bindingIndex ? { ...binding, ...update } : binding,
      ),
      workflowInputKeys,
    );
  const removeBinding = (bindingIndex: number) =>
    onChange(
      step.inputs.filter((_, current) => current !== bindingIndex),
      workflowInputKeys,
    );
  const addBinding = () => {
    const candidate =
      [...choices].reverse().find((choice) => choice.output.required) ?? choices.at(-1);
    if (!candidate) return;
    const base = candidate.output.key.replace(/[^A-Za-z0-9_]/g, '_') || 'input';
    const key = fieldName(base, Object.fromEntries(step.inputs.map((item) => [item.key, item])));
    onChange(
      [
        ...step.inputs,
        { key, fromStepId: candidate.step.id, outputKey: candidate.output.key, required: true },
      ],
      workflowInputKeys,
    );
  };

  return (
    <div className="workflow-editor-subsection">
      <h4>输入绑定</h4>
      {step.inputs.length > 0 ? (
        <div className="workflow-editor-row-list">
          {step.inputs.map((binding, bindingIndex) => {
            const available = choices.filter((choice) => choice.step.id === binding.fromStepId);
            return (
              <fieldset className="workflow-editor-row" key={`${binding.key}-${bindingIndex}`}>
                <legend>输入 {bindingIndex + 1}</legend>
                <div className="workflow-editor-grid">
                  <Field label="绑定键">
                    <input
                      value={binding.key}
                      maxLength={64}
                      aria-label={`步骤 ${index + 1} 输入 ${bindingIndex + 1} 绑定键`}
                      onChange={(event) => updateBinding(bindingIndex, { key: event.target.value })}
                    />
                  </Field>
                  <Field label="上游步骤">
                    <select
                      value={binding.fromStepId}
                      aria-label={`步骤 ${index + 1} 输入 ${bindingIndex + 1} 上游步骤`}
                      onChange={(event) => {
                        const next = choices.find(
                          (choice) => choice.step.id === event.target.value,
                        );
                        updateBinding(bindingIndex, {
                          fromStepId: event.target.value,
                          outputKey: next?.output.key ?? '',
                        });
                      }}
                    >
                      {upstream.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="上游输出">
                    <select
                      value={binding.outputKey}
                      aria-label={`步骤 ${index + 1} 输入 ${bindingIndex + 1} 上游输出`}
                      onChange={(event) =>
                        updateBinding(bindingIndex, { outputKey: event.target.value })
                      }
                    >
                      {available.map((choice) => (
                        <option key={choice.output.key} value={choice.output.key}>
                          {choice.output.key} · {choice.output.kind}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <label className="workflow-editor-checkbox">
                    <input
                      type="checkbox"
                      checked={binding.required}
                      aria-label={`步骤 ${index + 1} 输入 ${bindingIndex + 1} 必填`}
                      onChange={(event) =>
                        updateBinding(bindingIndex, { required: event.target.checked })
                      }
                    />
                    <span>必需输入</span>
                  </label>
                  <Button
                    variant="ghost"
                    className="small"
                    onClick={() => removeBinding(bindingIndex)}
                  >
                    删除绑定
                  </Button>
                </div>
              </fieldset>
            );
          })}
        </div>
      ) : (
        <p className="workflow-editor-empty">此步骤尚未绑定上游交付。</p>
      )}
      <Button
        variant="secondary"
        className="small"
        disabled={choices.length === 0}
        onClick={addBinding}
      >
        添加上游绑定
      </Button>

      <fieldset className="workflow-editor-choice-list">
        <legend>读取工作流输入</legend>
        {inputKeys.length ? (
          inputKeys.map((key) => (
            <label className="workflow-editor-checkbox" key={key}>
              <input
                type="checkbox"
                checked={workflowInputKeys.includes(key)}
                aria-label={`步骤 ${index + 1} 使用输入 ${key}`}
                onChange={(event) =>
                  onChange(
                    step.inputs,
                    event.target.checked
                      ? [...new Set([...workflowInputKeys, key])]
                      : workflowInputKeys.filter((item) => item !== key),
                  )
                }
              />
              <span>{content.inputSchema.properties[key]?.title || key}</span>
            </label>
          ))
        ) : (
          <p className="workflow-editor-empty">先在「输入约定」中添加字段。</p>
        )}
      </fieldset>
    </div>
  );
}

function outputDefault(kind: WorkflowArtifactKind, key: string): DraftOutput {
  const common = {
    key,
    kind,
    required: true,
    contractId: `user.${kind.toLowerCase()}-result`,
    contractVersion: '1',
    maxSizeBytes: 16_384,
    description: '步骤生成的结构化交付',
  };
  if (kind === 'TEXT')
    return { ...common, validator: { type: 'TEXT', minLength: 1, requiredSections: [] } };
  if (kind === 'JSON') return { ...common, validator: { type: 'JSON', requiredKeys: [] } };
  return { ...common, validator: { type: 'METADATA', allowedExtensions: [] } };
}

function OutputSpecEditor({
  output,
  index,
  lockedReview,
  onChange,
  onRemove,
}: {
  output: DraftOutput;
  index: number;
  lockedReview: boolean;
  onChange: (next: DraftOutput) => void;
  onRemove: () => void;
}) {
  const changeKind = (kind: WorkflowArtifactKind) =>
    onChange({
      ...outputDefault(kind, output.key || `output${index + 1}`),
      ...output,
      kind,
      validator: outputDefault(kind, output.key || `output${index + 1}`).validator,
    });
  const updateValidator = (next: DraftOutput['validator']) =>
    onChange({ ...output, validator: next });
  return (
    <fieldset className="workflow-editor-row" data-testid="workflow-output-spec">
      <legend>输出约定 {index + 1}</legend>
      <div className="workflow-editor-grid">
        <Field label="输出键">
          <input
            value={output.key}
            maxLength={64}
            disabled={lockedReview}
            aria-label={`输出约定 ${index + 1} 键`}
            onChange={(event) => onChange({ ...output, key: event.target.value })}
          />
        </Field>
        <Field label="交付类型">
          {lockedReview ? (
            <span className="workflow-editor-locked-value">结构化审核结果</span>
          ) : (
            <select
              value={output.kind}
              aria-label={`输出约定 ${index + 1} 类型`}
              onChange={(event) => changeKind(event.target.value as WorkflowArtifactKind)}
            >
              {ARTIFACT_KINDS.map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="约定编号">
          <input
            value={output.contractId}
            maxLength={128}
            aria-label={`输出约定 ${index + 1} 约定编号`}
            onChange={(event) => onChange({ ...output, contractId: event.target.value })}
          />
        </Field>
        <Field label="约定版本">
          <input
            value={output.contractVersion}
            maxLength={32}
            aria-label={`输出约定 ${index + 1} 约定版本`}
            onChange={(event) => onChange({ ...output, contractVersion: event.target.value })}
          />
        </Field>
        <NumberField
          label="最大字节数"
          value={output.maxSizeBytes}
          min={1}
          max={MAX_OUTPUT_SIZE}
          onChange={(next) => onChange({ ...output, maxSizeBytes: next })}
        />
        <Field label="交付说明">
          <input
            value={output.description}
            maxLength={300}
            aria-label={`输出约定 ${index + 1} 说明`}
            onChange={(event) => onChange({ ...output, description: event.target.value })}
          />
        </Field>
        <label className="workflow-editor-checkbox">
          <input
            type="checkbox"
            checked={output.required}
            disabled={lockedReview}
            aria-label={`输出约定 ${index + 1} 必需`}
            onChange={(event) => onChange({ ...output, required: event.target.checked })}
          />
          <span>必需输出</span>
        </label>
        <Button variant="ghost" className="small" disabled={lockedReview} onClick={onRemove}>
          删除输出
        </Button>
      </div>
      {output.validator.type === 'TEXT' && (
        <div className="workflow-editor-grid">
          <NumberField
            label="最少字符"
            value={output.validator.minLength}
            min={0}
            max={MAX_TEXT_OUTPUT_LENGTH}
            onChange={(next) => updateValidator({ ...output.validator, minLength: next })}
          />
          <Field label="必须包含的章节（每行一项）">
            <textarea
              rows={2}
              value={output.validator.requiredSections.join('\n')}
              onChange={(event) =>
                updateValidator({
                  ...output.validator,
                  requiredSections: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .slice(0, 20)
                    .map((item) => item.slice(0, 256)),
                })
              }
            />
          </Field>
        </div>
      )}
      {output.validator.type === 'JSON' && lockedReview ? (
        <p className="workflow-editor-hint">必需字段：{REVIEW_REQUIRED_KEYS.join('、')}。</p>
      ) : (
        output.validator.type === 'JSON' && (
          <Field label="必需 JSON 键（每行一项）">
            <textarea
              rows={2}
              value={output.validator.requiredKeys.join('\n')}
              onChange={(event) =>
                updateValidator({
                  ...output.validator,
                  requiredKeys: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .slice(0, 64)
                    .map((item) => item.slice(0, 128)),
                })
              }
            />
          </Field>
        )
      )}
      {output.validator.type === 'METADATA' && (
        <Field label="允许扩展名（每行一项）">
          <textarea
            rows={2}
            value={output.validator.allowedExtensions.join('\n')}
            onChange={(event) =>
              updateValidator({
                ...output.validator,
                allowedExtensions: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 16)
                  .map((item) => item.slice(0, 16)),
              })
            }
          />
        </Field>
      )}
    </fieldset>
  );
}

function BranchEditor({
  step,
  index,
  steps,
  edges,
  onChange,
  onAdd,
  onRemove,
}: {
  step: DraftStep;
  index: number;
  steps: DraftStep[];
  edges: DraftEdge[];
  onChange: (next: DraftEdge) => void;
  onAdd: () => void;
  onRemove: (edgeId: string) => void;
}) {
  const targets = steps.slice(index + 1);
  const branchEdges = edges.filter((item) => item.fromStepId === step.id);
  const jsonInputs = step.inputs.filter(
    (input) =>
      outputOf(
        steps.find((item) => item.id === input.fromStepId),
        input.outputKey,
      )?.kind === 'JSON',
  );
  const usedVerdicts = new Set(
    branchEdges.flatMap((item) =>
      item.condition.type === 'REVIEW_VERDICT' ? [item.condition.verdict] : [],
    ),
  );
  const canAddReviewBranch = (['PASS', 'REVISE', 'FAIL'] as const).some(
    (verdict) => !usedVerdicts.has(verdict),
  );
  return (
    <div className="workflow-editor-subsection">
      <h4>条件分支</h4>
      {branchEdges.length ? (
        branchEdges.map((branch, branchIndex) => (
          <fieldset
            className="workflow-editor-row"
            key={branch.id}
            data-testid="workflow-branch-row"
          >
            <legend>分支 {branchIndex + 1}</legend>
            <div className="workflow-editor-grid">
              <Field label="分支名称">
                <input
                  value={branch.branch}
                  maxLength={80}
                  aria-label={`步骤 ${index + 1} 分支 ${branchIndex + 1} 名称`}
                  onChange={(event) => onChange({ ...branch, branch: event.target.value })}
                />
              </Field>
              <Field label="目标步骤">
                <select
                  value={branch.toStepId ?? ''}
                  aria-label={`步骤 ${index + 1} 分支 ${branchIndex + 1} 目标`}
                  onChange={(event) =>
                    onChange({ ...branch, toStepId: event.target.value || null })
                  }
                >
                  <option value="">结束工作流</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.title}
                    </option>
                  ))}
                </select>
              </Field>
              {step.type === 'REVIEW' && branch.condition.type === 'REVIEW_VERDICT' && (
                <Field label="审核结论">
                  <select
                    value={branch.condition.verdict}
                    onChange={(event) =>
                      onChange({
                        ...branch,
                        condition: {
                          ...branch.condition,
                          verdict: event.target.value as 'PASS' | 'REVISE' | 'FAIL',
                        },
                      })
                    }
                  >
                    <option value="PASS">通过</option>
                    <option value="REVISE">需要修改</option>
                    <option value="FAIL">未通过</option>
                  </select>
                </Field>
              )}
              {step.type === 'DECISION' && branch.condition.type === 'JSON_FIELD_EQUALS' && (
                <>
                  <Field label="读取的 JSON 输入">
                    <select
                      value={branch.condition.inputKey}
                      aria-label={`步骤 ${index + 1} 分支 ${branchIndex + 1} 输入键`}
                      onChange={(event) =>
                        onChange({
                          ...branch,
                          condition: { ...branch.condition, inputKey: event.target.value },
                        })
                      }
                    >
                      {jsonInputs.map((input) => (
                        <option key={input.key} value={input.key}>
                          {input.key}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="JSON 字段">
                    <input
                      value={branch.condition.field}
                      maxLength={128}
                      aria-label={`步骤 ${index + 1} 分支 ${branchIndex + 1} JSON 字段`}
                      onChange={(event) =>
                        onChange({
                          ...branch,
                          condition: { ...branch.condition, field: event.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="匹配值类型">
                    <select
                      value={typeof branch.condition.equals}
                      onChange={(event) => {
                        const nextType = event.target.value;
                        const current = String(branch.condition.equals);
                        const equals =
                          nextType === 'number'
                            ? numberValue(current, 0)
                            : nextType === 'boolean'
                              ? current === 'true'
                              : current;
                        onChange({ ...branch, condition: { ...branch.condition, equals } });
                      }}
                    >
                      <option value="string">文本</option>
                      <option value="number">数字</option>
                      <option value="boolean">是 / 否</option>
                    </select>
                  </Field>
                  <Field label="匹配值">
                    {typeof branch.condition.equals === 'boolean' ? (
                      <select
                        value={String(branch.condition.equals)}
                        onChange={(event) =>
                          onChange({
                            ...branch,
                            condition: {
                              ...branch.condition,
                              equals: event.target.value === 'true',
                            },
                          })
                        }
                      >
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        type={typeof branch.condition.equals === 'number' ? 'number' : 'text'}
                        value={branch.condition.equals}
                        aria-label={`步骤 ${index + 1} 分支 ${branchIndex + 1} 匹配值`}
                        onChange={(event) =>
                          onChange({
                            ...branch,
                            condition: {
                              ...branch.condition,
                              equals:
                                typeof branch.condition.equals === 'number'
                                  ? numberValue(event.target.value, branch.condition.equals)
                                  : event.target.value,
                            },
                          })
                        }
                      />
                    )}
                  </Field>
                </>
              )}
            </div>
            <Button variant="ghost" className="small" onClick={() => onRemove(branch.id)}>
              删除分支
            </Button>
          </fieldset>
        ))
      ) : (
        <p className="workflow-editor-empty">此步骤使用顺序连接。</p>
      )}
      {step.type === 'REVIEW' && (
        <Button
          variant="secondary"
          className="small"
          disabled={!canAddReviewBranch}
          data-testid={`workflow-branch-add-${step.id}`}
          onClick={onAdd}
        >
          添加条件分支
        </Button>
      )}
      {step.type === 'DECISION' && (
        <>
          {jsonInputs.length === 0 && (
            <p className="workflow-editor-hint">
              请先绑定一个上游 JSON 输出，决策条件才能读取字段。
            </p>
          )}
          <Button
            variant="secondary"
            className="small"
            disabled={jsonInputs.length === 0}
            data-testid={`workflow-branch-add-${step.id}`}
            onClick={onAdd}
          >
            添加条件分支
          </Button>
        </>
      )}
      {step.type === 'TASK' && (
        <p className="workflow-editor-hint">条件分支由审核或决策步骤声明。</p>
      )}
    </div>
  );
}

function FinalOutputsEditor({
  content,
  onChange,
}: {
  content: WorkflowDraftContent;
  onChange: (next: WorkflowDraftContent) => void;
}) {
  const choices = outputChoices(content.steps);
  const update = (index: number, changes: Partial<WorkflowDraftContent['finalOutputs'][number]>) =>
    onChange({
      ...content,
      finalOutputs: content.finalOutputs.map((item, current) =>
        current === index ? { ...item, ...changes } : item,
      ),
    });
  return (
    <div className="workflow-editor-row-list">
      {content.finalOutputs.length ? (
        content.finalOutputs.map((output, index) => (
          <fieldset
            className="workflow-editor-row"
            key={`${output.key}-${index}`}
            data-testid="workflow-final-output"
          >
            <legend>最终输出 {index + 1}</legend>
            <div className="workflow-editor-grid">
              <Field label="输出名称">
                <input
                  value={output.key}
                  maxLength={128}
                  aria-label={`最终输出 ${index + 1} 名称`}
                  onChange={(event) => update(index, { key: event.target.value })}
                />
              </Field>
              <Field label="来源交付">
                <select
                  value={`${output.fromStepId}::${output.outputKey}`}
                  aria-label={`最终输出 ${index + 1} 来源交付`}
                  onChange={(event) => {
                    const [fromStepId, outputKey] = event.target.value.split('::');
                    if (fromStepId && outputKey) update(index, { fromStepId, outputKey });
                  }}
                >
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="输出说明">
                <input
                  value={output.description}
                  maxLength={300}
                  aria-label={`最终输出 ${index + 1} 说明`}
                  onChange={(event) => update(index, { description: event.target.value })}
                />
              </Field>
              <label className="workflow-editor-checkbox">
                <input
                  type="checkbox"
                  checked={output.required}
                  aria-label={`最终输出 ${index + 1} 必需`}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                <span>必需输出</span>
              </label>
              <Button
                variant="ghost"
                className="small"
                aria-label={`删除最终输出 ${output.key}`}
                onClick={() =>
                  onChange({
                    ...content,
                    finalOutputs: content.finalOutputs.filter((_, current) => current !== index),
                  })
                }
              >
                删除输出
              </Button>
            </div>
          </fieldset>
        ))
      ) : (
        <p className="workflow-editor-empty">尚未声明最终输出。</p>
      )}
      <Button
        variant="secondary"
        className="small"
        disabled={!choices.length}
        data-testid="workflow-final-output-add"
        onClick={() => {
          const source =
            [...choices].reverse().find((choice) => choice.output.required) ?? choices.at(-1);
          if (!source) return;
          const key = fieldName(
            source.output.key || 'result',
            Object.fromEntries(content.finalOutputs.map((item) => [item.key, item])),
          );
          onChange({
            ...content,
            finalOutputs: [
              ...content.finalOutputs,
              {
                key,
                fromStepId: source.step.id,
                outputKey: source.output.key,
                required: true,
                description: source.output.description,
              },
            ],
          });
        }}
      >
        添加最终输出
      </Button>
    </div>
  );
}

export function WorkflowEditor({
  draft,
  api,
  onCancel,
  onSaved,
  onPublished,
}: {
  draft: WorkflowDraft;
  api: WorkflowEditorApi;
  onCancel: () => void;
  onSaved: (draft: WorkflowDraft) => void;
  onPublished: (version: WorkflowVersion) => void;
}) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [content, setContent] = useState(draft.content);
  const [savedContent, setSavedContent] = useState(draft.content);
  const [nextStepType, setNextStepType] = useState<WorkflowStepType>('TASK');
  const [expandedSteps, setExpandedSteps] = useState<string[]>([draft.content.steps[0]?.id ?? '']);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackIsError, setFeedbackIsError] = useState(false);
  const dirty = useMemo(
    () => JSON.stringify(content) !== JSON.stringify(savedContent),
    [content, savedContent],
  );

  useEffect(() => {
    setCurrentDraft(draft);
    setContent(draft.content);
    setSavedContent(draft.content);
    setExpandedSteps([draft.content.steps[0]?.id ?? '']);
    setFeedback('');
  }, [draft.id]);

  const changeContent = (next: WorkflowDraftContent) => {
    setContent(next);
    setFeedback('');
    setFeedbackIsError(false);
  };

  const saveCurrentDraft = async (nextContent = content): Promise<WorkflowDraft> => {
    const saved = await api.saveDraft({
      id: currentDraft.id,
      expectedRevision: currentDraft.revision,
      content: nextContent,
    });
    setCurrentDraft(saved);
    setContent(saved.content);
    setSavedContent(saved.content);
    onSaved(saved);
    return saved;
  };

  const handleSave = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setFeedback('');
    try {
      await saveCurrentDraft();
      setFeedback('草稿已保存。');
      setFeedbackIsError(false);
    } catch (error) {
      setFeedback(safeError(error, '保存草稿失败，请检查工作流内容后重试。'));
      setFeedbackIsError(true);
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback('');
    try {
      const latest = dirty ? await saveCurrentDraft() : currentDraft;
      const version = await api.publishDraft({ id: latest.id, expectedRevision: latest.revision });
      setFeedbackIsError(false);
      onPublished(version);
    } catch (error) {
      setFeedback(safeError(error, '发布失败，请检查工作流内容后重试。'));
      setFeedbackIsError(true);
    } finally {
      setBusy(false);
    }
  };

  const moveStep = async (from: number, to: number) => {
    if (busy || to < 0 || to >= content.steps.length || from === to) return;
    const reorderedSteps = [...content.steps];
    const [moved] = reorderedSteps.splice(from, 1);
    if (!moved) return;
    reorderedSteps.splice(to, 0, moved);
    const stepIds = reorderedSteps.map((step) => step.id);
    setBusy(true);
    setFeedback('');
    try {
      const latest = dirty ? await saveCurrentDraft() : currentDraft;
      const reordered = await api.reorderDraft({
        id: latest.id,
        expectedRevision: latest.revision,
        stepIds,
      });
      setCurrentDraft(reordered);
      setContent(reordered.content);
      setSavedContent(reordered.content);
      setFeedback('步骤顺序已更新。');
      setFeedbackIsError(false);
      onSaved(reordered);
    } catch (error) {
      setFeedback(safeError(error, '无法更新步骤顺序，请重新检查步骤连接。'));
      setFeedbackIsError(true);
    } finally {
      setBusy(false);
    }
  };

  const addStepAndExpand = () => {
    const next = addWorkflowDraftStep(content, nextStepType);
    const added = next.steps.slice(content.steps.length);
    changeContent(next);
    if (added.length)
      setExpandedSteps((current) => [...new Set([...current, ...added.map((step) => step.id)])]);
  };

  const selectedVersion = currentDraft.baseVersion
    ? `基于 v${currentDraft.baseVersion}`
    : '新建草稿';
  return (
    <div className="workflow-editor" data-testid="workflow-editor">
      <header className="workflow-editor-heading">
        <div>
          <div className="workflow-editor-heading-status">
            <StatusBadge tone={dirty ? 'warning' : 'neutral'}>
              {dirty ? '未保存' : '草稿'}
            </StatusBadge>
            <span>{selectedVersion}</span>
          </div>
          <h2>编辑工作流</h2>
        </div>
        <div className="workflow-editor-actions">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            返回列表
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !dirty}
            data-testid="workflow-draft-save"
            onClick={() => void handleSave()}
          >
            {busy ? '正在保存…' : '保存草稿'}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="workflow-draft-publish"
            onClick={() => void handlePublish()}
          >
            发布新版本
          </Button>
        </div>
      </header>
      {feedback && (
        <div
          className={`workflow-editor-feedback ${feedbackIsError ? 'error' : 'success'}`}
          role={feedbackIsError ? 'alert' : 'status'}
        >
          {feedback}
        </div>
      )}

      <Section title="工作流信息" className="workflow-editor-section">
        <div className="workflow-editor-grid">
          <Field label="名称">
            <input
              value={content.name}
              maxLength={128}
              data-testid="workflow-name"
              onChange={(event) => changeContent({ ...content, name: event.target.value })}
            />
          </Field>
          <Field label="分类">
            <input
              value={content.category}
              maxLength={80}
              data-testid="workflow-category"
              onChange={(event) => changeContent({ ...content, category: event.target.value })}
            />
          </Field>
        </div>
        <Field label="说明">
          <textarea
            value={content.description}
            rows={3}
            maxLength={2_000}
            data-testid="workflow-description"
            onChange={(event) => changeContent({ ...content, description: event.target.value })}
          />
        </Field>
      </Section>

      <Section title="输入约定" className="workflow-editor-section">
        <WorkflowInputSchemaEditor
          schema={content.inputSchema}
          onChange={(inputSchema) =>
            changeContent(updateWorkflowDraftInputSchema(content, inputSchema))
          }
        />
      </Section>

      <Section
        title={`步骤 · ${content.steps.length}`}
        className="workflow-editor-section"
        action={
          <div className="workflow-editor-add-step">
            <label>
              <span className="sr-only">新增步骤类型</span>
              <select
                aria-label="新增步骤类型"
                value={nextStepType}
                onChange={(event) => setNextStepType(event.target.value as WorkflowStepType)}
              >
                {STEP_TYPES.map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              className="small"
              disabled={busy}
              data-testid="workflow-step-add"
              onClick={addStepAndExpand}
            >
              添加步骤
            </Button>
          </div>
        }
      >
        <div className="workflow-editor-steps">
          {content.steps.map((step, index) => (
            <WorkflowStepEditor
              key={step.id}
              content={content}
              step={step}
              index={index}
              saving={busy}
              expanded={expandedSteps.includes(step.id)}
              onExpand={(expanded) =>
                setExpandedSteps((current) =>
                  expanded
                    ? [...new Set([...current, step.id])]
                    : current.filter((item) => item !== step.id),
                )
              }
              onChange={changeContent}
              onReorder={(from, to) => void moveStep(from, to)}
              onError={(message) => {
                setFeedback(message);
                setFeedbackIsError(Boolean(message));
              }}
            />
          ))}
        </div>
      </Section>

      <Section title="最终输出" className="workflow-editor-section">
        <FinalOutputsEditor content={content} onChange={changeContent} />
      </Section>

      <footer className="workflow-editor-footer">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          返回列表
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !dirty}
          data-testid="workflow-draft-save-footer"
          onClick={() => void handleSave()}
        >
          保存草稿
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          data-testid="workflow-draft-publish-footer"
          onClick={() => void handlePublish()}
        >
          发布新版本
        </Button>
      </footer>
    </div>
  );
}

export function convertWorkflowDraftStepType(
  content: WorkflowDraftContent,
  stepId: string,
  type: WorkflowStepType,
): { content: WorkflowDraftContent; error?: string } {
  const index = content.steps.findIndex((step) => step.id === stepId);
  const current = content.steps[index];
  if (!current || current.type === type) return { content };
  const outgoing = content.edges.filter((item) => item.fromStepId === stepId);
  if (outgoing.some((item) => item.condition.type !== 'ALWAYS'))
    return { content, error: '请先删除当前步骤的条件分支，再更改步骤类型。' };

  const priorOutput = content.steps
    .slice(0, index)
    .reverse()
    .flatMap((step) => step.outputs.map((output) => ({ step, output })))[0];
  if (type === 'REVIEW' && !priorOutput)
    return { content, error: '审核步骤需要一个上游交付，请先添加任务步骤。' };

  const nextStep = createStep(type, index);
  nextStep.id = current.id;
  nextStep.title = current.title;
  nextStep.objective = current.objective;
  nextStep.routing = { ...current.routing };
  nextStep.workflowInputKeys = current.workflowInputKeys ?? [];
  if (type === 'REVIEW' && priorOutput) {
    nextStep.inputs = [
      {
        key: 'reviewInput',
        fromStepId: priorOutput.step.id,
        outputKey: priorOutput.output.key,
        required: true,
      },
    ];
    const revision = createStep('TASK', index + 1);
    revision.title = '按审核意见修改';
    revision.objective = '根据审核步骤提供的修改意见完善交付，并提交修订结果。';
    revision.inputs = [
      { key: 'reviewFeedback', fromStepId: current.id, outputKey: 'review', required: true },
    ];
    const oldTarget = outgoing[0]?.toStepId ?? null;
    const edges = content.edges.filter((item) => item.fromStepId !== current.id);
    edges.push(
      edge(current.id, oldTarget, '通过', { type: 'REVIEW_VERDICT', verdict: 'PASS' }),
      edge(current.id, revision.id, '修改', { type: 'REVIEW_VERDICT', verdict: 'REVISE' }),
      edge(current.id, null, '未通过', { type: 'REVIEW_VERDICT', verdict: 'FAIL' }),
      edge(revision.id, oldTarget, '继续', { type: 'ALWAYS' }),
    );
    return {
      content: {
        ...content,
        steps: [
          ...content.steps.slice(0, index),
          nextStep,
          revision,
          ...content.steps.slice(index + 1),
        ],
        edges,
        finalOutputs: content.finalOutputs.map((output) =>
          output.fromStepId === current.id
            ? { ...output, fromStepId: revision.id, outputKey: 'result' }
            : output,
        ),
      },
    };
  }

  if (type === 'DECISION') {
    const jsonOutput = content.steps
      .slice(0, index)
      .reverse()
      .flatMap((step) => step.outputs.map((output) => ({ step, output })))
      .find(({ output }) => output.kind === 'JSON');
    if (jsonOutput)
      nextStep.inputs = [
        {
          key: 'decisionInput',
          fromStepId: jsonOutput.step.id,
          outputKey: jsonOutput.output.key,
          required: true,
        },
      ];
  } else if (type === 'TASK') {
    nextStep.outputs = current.outputs.length ? current.outputs : [createTextOutput()];
    nextStep.inputs = current.inputs;
  }
  const edges = content.edges.filter((item) => item.fromStepId !== current.id);
  if (outgoing.length) edges.push(...outgoing);
  else edges.push(edge(current.id, null, '完成', { type: 'ALWAYS' }));
  return {
    content: {
      ...content,
      steps: content.steps.map((step, currentIndex) => (currentIndex === index ? nextStep : step)),
      edges,
      finalOutputs: content.finalOutputs
        .map((output) =>
          output.fromStepId === current.id && type === 'TASK'
            ? { ...output, outputKey: nextStep.outputs[0]?.key ?? output.outputKey }
            : output,
        )
        .filter((output) => output.fromStepId !== current.id || type !== 'DECISION'),
    },
  };
}

export function addWorkflowDraftStep(
  content: WorkflowDraftContent,
  type: WorkflowStepType,
): WorkflowDraftContent {
  if (type === 'REVIEW') return appendReview(content);
  const step = createStep(type, content.steps.length);
  if (type === 'DECISION') {
    const source = content.steps
      .slice()
      .reverse()
      .flatMap((item) => item.outputs.map((output) => ({ step: item, output })))
      .find(({ output }) => output.kind === 'JSON');
    if (source)
      step.inputs = [
        {
          key: 'decisionInput',
          fromStepId: source.step.id,
          outputKey: source.output.key,
          required: true,
        },
      ];
  }
  return withTerminalStep(content, step);
}

function setEdge(content: WorkflowDraftContent, next: DraftEdge): WorkflowDraftContent {
  return {
    ...content,
    edges: content.edges.map((item) => (item.id === next.id ? next : item)),
  };
}

export function removeWorkflowDraftStep(
  content: WorkflowDraftContent,
  stepId: string,
): { content: WorkflowDraftContent; error?: string } {
  const step = content.steps.find((item) => item.id === stepId);
  if (!step) return { content };
  const incoming = content.edges.filter((item) => item.toStepId === stepId);
  const outgoing = content.edges.filter((item) => item.fromStepId === stepId);
  if (outgoing.length > 1) return { content, error: '请先整理此步骤的条件分支，再删除步骤。' };

  const nextSteps = content.steps.filter((item) => item.id !== stepId);
  const nextEdges = content.edges.filter(
    (item) => item.fromStepId !== stepId && item.toStepId !== stepId,
  );
  const nextTarget = outgoing[0]?.toStepId ?? null;
  nextEdges.push(...incoming.map((item) => ({ ...item, toStepId: nextTarget })));
  const entryStepId =
    content.entryStepId === stepId ? (nextTarget ?? nextSteps[0]?.id ?? '') : content.entryStepId;
  return {
    content: {
      ...content,
      steps: nextSteps,
      edges: nextEdges,
      entryStepId,
      finalOutputs: content.finalOutputs.filter((item) => item.fromStepId !== stepId),
    },
  };
}

export function WorkflowStepEditor({
  content,
  step,
  index,
  saving,
  expanded,
  onExpand,
  onChange,
  onReorder,
  onError,
}: {
  content: WorkflowDraftContent;
  step: DraftStep;
  index: number;
  saving: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onChange: (next: WorkflowDraftContent) => void;
  onReorder: (from: number, to: number) => void;
  onError: (message: string) => void;
}) {
  const update = (changes: Partial<DraftStep>) =>
    onChange({
      ...content,
      steps: content.steps.map((current) =>
        current.id === step.id ? { ...current, ...changes } : current,
      ),
    });
  const updateOutput = (outputIndex: number, next: DraftOutput) =>
    update({
      outputs: step.outputs.map((item, current) => (current === outputIndex ? next : item)),
    });
  const move = (to: number) => {
    if (to < 0 || to >= content.steps.length || to === index) return;
    onReorder(index, to);
  };
  const addBranch = () => {
    if (step.type === 'TASK') return;
    const oldTerminal = content.edges.find(
      (item) =>
        item.fromStepId === step.id && item.condition.type === 'ALWAYS' && item.toStepId === null,
    );
    const verdicts = content.edges
      .filter((item) => item.fromStepId === step.id && item.condition.type === 'REVIEW_VERDICT')
      .map((item) => (item.condition.type === 'REVIEW_VERDICT' ? item.condition.verdict : 'PASS'));
    const nextVerdict = (['PASS', 'REVISE', 'FAIL'] as const).find(
      (verdict) => !verdicts.includes(verdict),
    );
    const jsonInput = step.inputs.find(
      (input) =>
        outputOf(
          content.steps.find((item) => item.id === input.fromStepId),
          input.outputKey,
        )?.kind === 'JSON',
    );
    const source =
      step.type === 'REVIEW'
        ? nextVerdict && {
            branch: nextVerdict === 'PASS' ? '通过' : nextVerdict === 'REVISE' ? '修改' : '未通过',
            condition: { type: 'REVIEW_VERDICT', verdict: nextVerdict } as const,
          }
        : {
            branch: '符合条件',
            condition: {
              type: 'JSON_FIELD_EQUALS',
              inputKey: jsonInput?.key ?? '',
              field: 'status',
              equals: 'done',
            } as const,
          };
    if (!source) return;
    const edges = content.edges.filter((item) => item.id !== oldTerminal?.id);
    edges.push(edge(step.id, null, source.branch, source.condition));
    onChange({ ...content, edges });
  };

  return (
    <article
      className="workflow-editor-step-card"
      data-testid="workflow-step-card"
      data-step-id={step.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const from = Number(event.dataTransfer.getData('text/workflow-step-index'));
        if (Number.isInteger(from) && from >= 0 && from < content.steps.length && from !== index)
          onReorder(from, index);
      }}
    >
      <details open={expanded} onToggle={(event) => onExpand(event.currentTarget.open)}>
        <summary className="workflow-editor-step-summary">
          <span className="workflow-editor-step-number">{index + 1}</span>
          <span className="workflow-editor-step-summary-copy">
            <strong>{step.title || `步骤 ${index + 1}`}</strong>
            <small>{STEP_TYPES.find(([type]) => type === step.type)?.[1] ?? step.type}</small>
          </span>
          <span
            className="workflow-editor-drag-handle"
            role="button"
            tabIndex={saving ? -1 : 0}
            draggable={!saving}
            aria-label={`拖动排序步骤 ${step.title}`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            title="拖动排序；也可用方向键移动"
            data-testid="workflow-step-drag-handle"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                onReorder(index, index - 1);
              } else if (event.key === 'ArrowDown' && index < content.steps.length - 1) {
                event.preventDefault();
                onReorder(index, index + 1);
              }
            }}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/workflow-step-index', String(index));
            }}
          >
            ↕
          </span>
          <span className="workflow-editor-step-toggle">展开编辑</span>
        </summary>
        <div className="workflow-editor-step-body">
          <div className="workflow-editor-step-controls">
            <Button
              variant="ghost"
              className="small"
              disabled={saving || index === 0}
              aria-label={`上移步骤 ${step.title}`}
              onClick={() => move(index - 1)}
            >
              上移步骤
            </Button>
            <Button
              variant="ghost"
              className="small"
              disabled={saving || index === content.steps.length - 1}
              aria-label={`下移步骤 ${step.title}`}
              onClick={() => move(index + 1)}
            >
              下移步骤
            </Button>
            <Button
              variant="ghost"
              className="small"
              disabled={saving || content.steps.length <= 1}
              aria-label={`删除步骤 ${step.title}`}
              onClick={() => {
                const result = removeWorkflowDraftStep(content, step.id);
                if (result.error) onError(result.error);
                else {
                  onError('');
                  onChange(result.content);
                }
              }}
            >
              删除步骤
            </Button>
          </div>

          <div className="workflow-editor-grid">
            <Field label="步骤类型">
              <select
                value={step.type}
                aria-label={`步骤 ${index + 1} 类型`}
                data-testid="workflow-step-type"
                onChange={(event) => {
                  const result = convertWorkflowDraftStepType(
                    content,
                    step.id,
                    event.target.value as WorkflowStepType,
                  );
                  if (result.error) onError(result.error);
                  else {
                    onError('');
                    onChange(result.content);
                  }
                }}
              >
                {STEP_TYPES.map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="步骤标题">
              <input
                value={step.title}
                maxLength={128}
                aria-label={`步骤 ${index + 1} 标题`}
                data-testid="workflow-step-title"
                onChange={(event) => update({ title: event.target.value })}
              />
            </Field>
          </div>
          <Field label="步骤目标">
            <textarea
              value={step.objective}
              rows={3}
              maxLength={6_000}
              aria-label={`步骤 ${index + 1} 目标`}
              data-testid="workflow-step-objective"
              onChange={(event) => update({ objective: event.target.value })}
            />
          </Field>

          <div className="workflow-editor-subsection">
            <h4>任务能力与执行方式</h4>
            <Field label="执行约束">
              <select
                value={step.routing.executionConstraint ?? 'AUTO'}
                aria-label={`步骤 ${index + 1} 执行约束`}
                data-testid="workflow-step-execution-constraint"
                onChange={(event) =>
                  update({
                    routing: {
                      ...step.routing,
                      executionConstraint: event.target
                        .value as DraftStep['routing']['executionConstraint'],
                    },
                  })
                }
              >
                {EXECUTION_CONSTRAINTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <CapabilityPicker
              selected={step.routing.requiredCapabilities ?? []}
              onChange={(selected) =>
                update({ routing: { ...step.routing, requiredCapabilities: selected } })
              }
            />
          </div>

          <InputBindingsEditor
            step={step}
            index={index}
            content={content}
            onChange={(inputs, workflowInputKeys) => update({ inputs, workflowInputKeys })}
          />

          <div className="workflow-editor-subsection">
            <h4>输出约定</h4>
            {step.type === 'DECISION' ? (
              <p className="workflow-editor-empty">决策步骤只按已声明条件选择分支，不生成交付。</p>
            ) : (
              <>
                {step.outputs.map((output, outputIndex) => {
                  const lockedReview =
                    step.type === 'REVIEW' && output.key === step.reviewOutputKey;
                  return (
                    <OutputSpecEditor
                      key={outputIndex}
                      output={output}
                      index={outputIndex}
                      lockedReview={lockedReview}
                      onChange={(next) => updateOutput(outputIndex, next)}
                      onRemove={() =>
                        update({
                          outputs: step.outputs.filter((_, current) => current !== outputIndex),
                        })
                      }
                    />
                  );
                })}
                <Button
                  variant="secondary"
                  className="small"
                  data-testid="workflow-output-add"
                  onClick={() =>
                    update({
                      outputs: [
                        ...step.outputs,
                        outputDefault(
                          'TEXT',
                          fieldName(
                            'output',
                            Object.fromEntries(step.outputs.map((item) => [item.key, item])),
                          ),
                        ),
                      ],
                    })
                  }
                >
                  添加输出约定
                </Button>
              </>
            )}
          </div>

          {step.type === 'REVIEW' && (
            <fieldset className="workflow-editor-review-policy">
              <legend>审核设置</legend>
              <Field label="审核结果编号">
                <select
                  value={step.reviewOutputKey ?? ''}
                  aria-label={`步骤 ${index + 1} 审核结果编号`}
                  onChange={(event) => update({ reviewOutputKey: event.target.value })}
                >
                  {step.outputs
                    .filter((output) => output.kind === 'JSON' && output.required)
                    .map((output) => (
                      <option key={output.key} value={output.key}>
                        {output.key}
                      </option>
                    ))}
                </select>
              </Field>
            </fieldset>
          )}

          <div className="workflow-editor-grid">
            <NumberField
              label="最多尝试次数"
              value={step.maxAttempts}
              min={1}
              max={5}
              onChange={(next) => update({ maxAttempts: next })}
            />
            <Field label="退出条件">
              <select
                value={step.exitCondition}
                aria-label={`步骤 ${index + 1} 退出条件`}
                onChange={(event) =>
                  update({ exitCondition: event.target.value as DraftStep['exitCondition'] })
                }
              >
                <option value="VALID_OUTPUTS">输出通过验证</option>
                {step.type === 'REVIEW' && (
                  <option value="REVIEW_PASS">审核结论为通过后继续</option>
                )}
              </select>
            </Field>
          </div>

          <BranchEditor
            step={step}
            index={index}
            steps={content.steps}
            edges={content.edges}
            onChange={(next) => onChange(setEdge(content, next))}
            onAdd={addBranch}
            onRemove={(edgeId) =>
              onChange({ ...content, edges: content.edges.filter((item) => item.id !== edgeId) })
            }
          />
        </div>
      </details>
    </article>
  );
}
