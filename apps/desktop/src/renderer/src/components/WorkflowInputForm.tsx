import React, { useState } from 'react';
import {
  validateWorkflowInputs,
  type WorkflowInputs,
  type WorkflowObjectSchema,
  type WorkflowValueSchema,
} from '@cultivation/domain';

type DraftRecord = Record<string, unknown>;

function isRecord(value: unknown): value is DraftRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function initialValue(schema: WorkflowValueSchema): unknown {
  switch (schema.type) {
    case 'string':
    case 'date':
      return '';
    case 'number':
      return '';
    case 'boolean':
      return false;
    case 'enum':
      return '';
    case 'array':
      return Array.from({ length: schema.minItems }, () => initialValue(schema.items));
    case 'object': {
      const value: DraftRecord = {};
      for (const key of schema.required) value[key] = initialValue(schema.properties[key]!);
      return value;
    }
    case 'dateRange':
      return { start: '', end: '' };
    case 'artifactRef':
      return { id: '', kind: schema.allowedKinds[0] ?? '' };
  }
}

export function createInitialWorkflowInputs(schema: WorkflowObjectSchema): DraftRecord {
  const value: DraftRecord = {};
  for (const key of schema.required) value[key] = initialValue(schema.properties[key]!);
  return value;
}

function normalizedValue(schema: WorkflowValueSchema, value: unknown): unknown {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'date':
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value !== 'string' || value.trim() === '') return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    case 'array':
      return Array.isArray(value)
        ? value.map((item) => normalizedValue(schema.items, item))
        : undefined;
    case 'object': {
      if (!isRecord(value)) return undefined;
      const result: DraftRecord = {};
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const normalized = normalizedValue(child, value[key]);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    }
    case 'dateRange': {
      if (!isRecord(value)) return undefined;
      return {
        start: typeof value.start === 'string' ? value.start : '',
        end: typeof value.end === 'string' ? value.end : '',
      };
    }
    case 'artifactRef': {
      if (!isRecord(value)) return undefined;
      const result: DraftRecord = {};
      if (typeof value.id === 'string') result.id = value.id;
      if (typeof value.kind === 'string') result.kind = value.kind;
      if (typeof value.name === 'string' && value.name.length > 0) result.name = value.name;
      return result;
    }
  }
}

export function normalizeWorkflowInputDraft(
  schema: WorkflowObjectSchema,
  draft: DraftRecord,
): WorkflowInputs {
  const result: DraftRecord = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(draft, key)) continue;
    const normalized = normalizedValue(field, draft[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result as WorkflowInputs;
}

function controlId(path: string): string {
  return `workflow-input-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function RequiredMark({ required }: { required: boolean }) {
  return required ? <span className="workflow-input-required">必填</span> : null;
}

function ClearOptionalField({
  name,
  required,
  value,
  disabled,
  onClear,
}: {
  name: string;
  required: boolean;
  value: unknown;
  disabled: boolean;
  onClear: () => void;
}) {
  if (required || value === undefined) return null;
  return (
    <button
      className="button secondary small workflow-input-clear"
      type="button"
      disabled={disabled}
      aria-label={`清除${name}输入`}
      onClick={onClear}
    >
      清除
    </button>
  );
}

function InputField({
  schema,
  name,
  path,
  value,
  required,
  disabled,
  onChange,
}: {
  schema: WorkflowValueSchema;
  name: string;
  path: string;
  value: unknown;
  required: boolean;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const id = controlId(path);
  const title = schema.title || name;
  const descriptionId = schema.description ? `${id}-description` : undefined;
  const describedBy = descriptionId;
  const label = (
    <label className="workflow-input-label" htmlFor={id}>
      {title} <RequiredMark required={required} />
    </label>
  );
  const description = schema.description ? (
    <p className="workflow-input-description" id={descriptionId}>
      {schema.description}
    </p>
  ) : null;

  if (schema.type === 'object') {
    const objectValue = isRecord(value) ? value : {};
    return (
      <fieldset className="workflow-input-group">
        <legend>
          {title} <RequiredMark required={required} />
        </legend>
        {description}
        <div className="workflow-input-fields">
          {Object.entries(schema.properties).map(([key, childSchema]) => (
            <InputField
              key={`${path}.${key}`}
              schema={childSchema}
              name={key}
              path={`${path}.${key}`}
              value={objectValue[key]}
              required={schema.required.includes(key)}
              disabled={disabled}
              onChange={(nextValue) => {
                const nextObject = { ...objectValue };
                if (nextValue === undefined) delete nextObject[key];
                else nextObject[key] = nextValue;
                onChange(nextObject);
              }}
            />
          ))}
        </div>
        <ClearOptionalField
          name={title}
          required={required}
          value={value}
          disabled={disabled}
          onClear={() => onChange(undefined)}
        />
      </fieldset>
    );
  }

  if (schema.type === 'array') {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset className="workflow-input-group workflow-input-array">
        <legend>
          {title} <RequiredMark required={required} />
        </legend>
        {description}
        <p className="workflow-input-hint">
          至少 {schema.minItems} 项，最多 {schema.maxItems} 项 · 当前 {items.length} 项
        </p>
        <div className="workflow-input-array-items">
          {items.map((item, index) => (
            <div className="workflow-input-array-item" key={`${path}[${index}]`}>
              <InputField
                schema={schema.items}
                name={`${title} · 第 ${index + 1} 项`}
                path={`${path}[${index}]`}
                value={item}
                required
                disabled={disabled}
                onChange={(nextValue) => {
                  const nextItems = [...items];
                  if (nextValue === undefined) nextItems[index] = initialValue(schema.items);
                  else nextItems[index] = nextValue;
                  onChange(nextItems);
                }}
              />
              <button
                className="button secondary small workflow-input-remove"
                type="button"
                disabled={disabled || items.length <= schema.minItems}
                aria-label={`移除${title}第 ${index + 1} 项`}
                onClick={() => onChange(items.filter((_item, itemIndex) => itemIndex !== index))}
              >
                移除
              </button>
            </div>
          ))}
        </div>
        <button
          className="button secondary small"
          type="button"
          disabled={disabled || items.length >= schema.maxItems}
          onClick={() => onChange([...items, initialValue(schema.items)])}
        >
          添加一项
        </button>
        <ClearOptionalField
          name={title}
          required={required}
          value={value}
          disabled={disabled}
          onClear={() => onChange(undefined)}
        />
      </fieldset>
    );
  }

  if (schema.type === 'artifactRef') {
    const artifact = isRecord(value) ? value : {};
    return (
      <fieldset className="workflow-input-group workflow-input-artifact-ref">
        <legend>
          {title} <RequiredMark required={required} />
        </legend>
        {description}
        <p className="workflow-input-hint">
          仅填写引用 ID、类型和可选名称；此表单不会读取文件或授予路径权限。
        </p>
        <div className="workflow-input-fields">
          <div className="workflow-input-field">
            <label className="workflow-input-label" htmlFor={`${id}-id`}>
              引用 ID
            </label>
            <input
              id={`${id}-id`}
              type="text"
              value={typeof artifact.id === 'string' ? artifact.id : ''}
              maxLength={128}
              disabled={disabled}
              autoComplete="off"
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...artifact, id: event.target.value })}
            />
          </div>
          <div className="workflow-input-field">
            <label className="workflow-input-label" htmlFor={`${id}-kind`}>
              类型
            </label>
            <select
              id={`${id}-kind`}
              value={typeof artifact.kind === 'string' ? artifact.kind : ''}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...artifact, kind: event.target.value })}
            >
              <option value="">请选择类型</option>
              {schema.allowedKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
          <div className="workflow-input-field">
            <label className="workflow-input-label" htmlFor={`${id}-name`}>
              名称（可选）
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={typeof artifact.name === 'string' ? artifact.name : ''}
              maxLength={256}
              disabled={disabled}
              autoComplete="off"
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...artifact, name: event.target.value })}
            />
          </div>
        </div>
        <ClearOptionalField
          name={title}
          required={required}
          value={value}
          disabled={disabled}
          onClear={() => onChange(undefined)}
        />
      </fieldset>
    );
  }

  if (schema.type === 'dateRange') {
    const range = isRecord(value) ? value : {};
    return (
      <fieldset className="workflow-input-group workflow-input-date-range">
        <legend>
          {title} <RequiredMark required={required} />
        </legend>
        {description}
        <div className="workflow-input-date-pair">
          {(['start', 'end'] as const).map((key) => (
            <div className="workflow-input-field" key={key}>
              <label className="workflow-input-label" htmlFor={`${id}-${key}`}>
                {key === 'start' ? '开始日期' : '结束日期'}
              </label>
              <input
                id={`${id}-${key}`}
                type="date"
                value={typeof range[key] === 'string' ? range[key] : ''}
                min={schema.minDate}
                max={schema.maxDate}
                required={required}
                disabled={disabled}
                aria-describedby={describedBy}
                onChange={(event) => onChange({ ...range, [key]: event.target.value })}
              />
            </div>
          ))}
        </div>
        <ClearOptionalField
          name={title}
          required={required}
          value={value}
          disabled={disabled}
          onClear={() => onChange(undefined)}
        />
      </fieldset>
    );
  }

  let control: React.ReactNode;
  if (schema.type === 'string') {
    control = (
      <input
        id={id}
        type="text"
        value={typeof value === 'string' ? value : ''}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        required={required}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (schema.type === 'number') {
    control = (
      <input
        id={id}
        type="number"
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.integer ? 1 : 'any'}
        required={required}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (schema.type === 'boolean') {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  } else if (schema.type === 'enum') {
    control = (
      <select
        id={id}
        value={typeof value === 'string' ? value : ''}
        required={required}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择</option>
        {schema.values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        id={id}
        type="date"
        value={typeof value === 'string' ? value : ''}
        min={schema.minDate}
        max={schema.maxDate}
        required={required}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div className={`workflow-input-field workflow-input-${schema.type}`}>
      {schema.type === 'boolean' ? (
        <div className="workflow-input-checkbox-row">
          {control}
          {label}
          <ClearOptionalField
            name={title}
            required={required}
            value={value}
            disabled={disabled}
            onClear={() => onChange(undefined)}
          />
        </div>
      ) : (
        <>
          {label}
          <div className="workflow-input-control-row">
            {control}
            <ClearOptionalField
              name={title}
              required={required}
              value={value}
              disabled={disabled}
              onClear={() => onChange(undefined)}
            />
          </div>
        </>
      )}
      {description}
    </div>
  );
}

export function WorkflowInputForm({
  schema,
  busy = false,
  submitLabel = '创建运行',
  onSubmit,
}: {
  schema: WorkflowObjectSchema;
  busy?: boolean;
  submitLabel?: string;
  onSubmit: (inputs: WorkflowInputs) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftRecord>(() => createInitialWorkflowInputs(schema));
  const [validationError, setValidationError] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError('');
    const inputs = normalizeWorkflowInputDraft(schema, draft);
    try {
      validateWorkflowInputs(schema, inputs);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '输入不符合此版本的约定。');
      return;
    }
    await onSubmit(inputs);
  };

  return (
    <form className="workflow-input-form" onSubmit={(event) => void submit(event)}>
      {schema.description && <p className="workflow-input-description">{schema.description}</p>}
      <div className="workflow-input-fields">
        {Object.entries(schema.properties).map(([key, field]) => (
          <InputField
            key={key}
            schema={field}
            name={key}
            path={key}
            value={draft[key]}
            required={schema.required.includes(key)}
            disabled={busy}
            onChange={(value) => {
              setDraft((current) => {
                const next = { ...current };
                if (value === undefined) delete next[key];
                else next[key] = value;
                return next;
              });
              setValidationError('');
            }}
          />
        ))}
      </div>
      {validationError && (
        <p className="workflow-input-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="workflow-input-submit-row">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? '处理中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
