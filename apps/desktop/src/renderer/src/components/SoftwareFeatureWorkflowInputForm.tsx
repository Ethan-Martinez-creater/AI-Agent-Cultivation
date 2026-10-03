import React, { useEffect, useMemo, useState } from 'react';
import {
  validateWorkflowInputs,
  type WorkflowInputs,
  type WorkflowObjectSchema,
} from '@cultivation/domain';
import type { ToolDescriptorView } from '../ui-shared.js';
import { WorkflowInputForm, type WorkflowInputPresentation } from './WorkflowInputForm.js';

const softwareFeatureFieldKeys = new Set(['workspaceRoot', 'allowedToolScope']);

export function softwareToolLabel(
  tool: ToolDescriptorView & { toolName?: string },
  serverName?: string,
): string {
  const builtinNames: Record<string, string> = {
    'file.list': '浏览目录',
    'file.readText': '读取文本',
    'file.writeText': '写入文本',
    'file.createDirectory': '创建目录',
  };
  return tool.source === 'MCP'
    ? `${serverName ?? 'MCP'} · ${tool.toolName ?? tool.name.split('.').at(-1) ?? '工具'}`
    : (builtinNames[tool.id] ?? tool.name);
}

export function mergeSoftwareFeatureToolOptions(
  builtinTools: readonly ToolDescriptorView[],
  mcpTools: readonly ToolDescriptorView[],
): ToolDescriptorView[] {
  const byId = new Map<string, ToolDescriptorView>();
  for (const tool of [...builtinTools, ...mcpTools]) {
    if (!byId.has(tool.id)) byId.set(tool.id, tool);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'zh-Hans-CN') || left.id.localeCompare(right.id),
  );
}

export function updateSelectedToolIds(value: unknown, toolId: string, checked: boolean): string[] {
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  if (checked) return selected.includes(toolId) ? selected : [...selected, toolId];
  return selected.filter((item) => item !== toolId);
}

export async function writeWorkspaceSelectionToInput(
  chooseWorkspace: () => Promise<string | null>,
  onChange: (value: string) => void,
): Promise<string | null> {
  const rootPath = await chooseWorkspace();
  if (rootPath) onChange(rootPath);
  return rootPath;
}

function RequiredMark({ required }: { required: boolean }) {
  return required ? <span className="workflow-input-required">必填</span> : null;
}

export function SoftwareFeatureWorkspaceRootField({
  value,
  required,
  disabled,
  pickerBusy,
  pickerError,
  onChooseWorkspace,
  onChange,
}: {
  value: string | null;
  required: boolean;
  disabled: boolean;
  pickerBusy: boolean;
  pickerError: string;
  onChooseWorkspace: () => Promise<string | null>;
  onChange: (rootPath: string) => void;
}) {
  const rootPath = value ?? '';
  const buttonId = 'workflow-input-workspaceRoot-choose';
  return (
    <div className="workflow-input-field">
      <label className="workflow-input-label" htmlFor={buttonId}>
        项目 Workspace <RequiredMark required={required} />
      </label>
      <div className="workflow-input-control-row">
        <button
          id={buttonId}
          className="button secondary small"
          type="button"
          disabled={disabled || pickerBusy}
          onClick={() => void writeWorkspaceSelectionToInput(onChooseWorkspace, onChange)}
        >
          {pickerBusy ? '正在选择…' : rootPath ? '更换 Workspace' : '选择 Workspace'}
        </button>
        <span className="workflow-input-hint">
          {rootPath ? '当前已选择 Workspace' : '尚未选择 Workspace'}
        </span>
      </div>
      {rootPath && (
        <code className="workflow-workspace-root" aria-label="当前 Workspace 根路径">
          {rootPath}
        </code>
      )}
      {pickerError && (
        <p className="workflow-input-error" role="alert">
          {pickerError}
        </p>
      )}
    </div>
  );
}

export function SoftwareFeatureAllowedToolScopeField({
  tools,
  selectedIds,
  required,
  disabled,
  maxItems,
  onChange,
}: {
  tools: readonly ToolDescriptorView[];
  selectedIds: readonly string[];
  required: boolean;
  disabled: boolean;
  maxItems: number;
  onChange: (ids: string[]) => void;
}) {
  const toolDescription = (tool: ToolDescriptorView) => {
    const description = tool.description.trim().replace(/\s+/g, ' ');
    if (description.length <= 180) return description || '未提供用途说明。';
    return `${description.slice(0, 177).trimEnd()}…`;
  };
  return (
    <fieldset className="workflow-input-group workflow-input-array">
      <legend>
        允许使用的工具 <RequiredMark required={required} />
      </legend>
      <p className="workflow-input-hint">
        最多选择 {maxItems} 项 · 当前 {selectedIds.length} 项
      </p>
      {tools.length ? (
        <div className="workflow-input-array-items">
          {tools.map((tool, index) => {
            const checked = selectedIds.includes(tool.id);
            const checkboxId = `workflow-input-allowedToolScope-${index}`;
            return (
              <div className="workflow-input-field" key={tool.id}>
                <div className="workflow-input-checkbox-row">
                  <input
                    id={checkboxId}
                    data-tool-id={tool.id}
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && selectedIds.length >= maxItems)}
                    onChange={(event) =>
                      onChange(updateSelectedToolIds(selectedIds, tool.id, event.target.checked))
                    }
                  />
                  <label className="workflow-input-label" htmlFor={checkboxId}>
                    {tool.name} · {tool.source === 'MCP' ? 'MCP 工具' : '内置工具'}
                  </label>
                </div>
                <span className="workflow-input-description">用途：{toolDescription(tool)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="workflow-input-hint">
          当前没有已发现工具。可先在“工具”页面连接已启用的 MCP 服务。
        </p>
      )}
      <details className="advanced-disclosure">
        <summary>高级 · 工具 ID</summary>
        {selectedIds.length ? (
          <ul>
            {selectedIds.map((toolId) => (
              <li key={toolId}>
                <code>{toolId}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>尚未选择工具。</p>
        )}
      </details>
    </fieldset>
  );
}

export function SoftwareFeatureWorkflowInputForm({
  schema,
  presentation,
  busy = false,
  onSubmit,
}: {
  schema: WorkflowObjectSchema;
  presentation?: WorkflowInputPresentation;
  busy?: boolean;
  onSubmit: (inputs: WorkflowInputs) => void | Promise<void>;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [toolOptions, setToolOptions] = useState<ToolDescriptorView[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingWarnings, setLoadingWarnings] = useState<string[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const [validationError, setValidationError] = useState('');

  const ordinaryInputSchema = useMemo(
    () =>
      ({
        ...schema,
        required: schema.required.filter((key) => !softwareFeatureFieldKeys.has(key)),
        properties: Object.fromEntries(
          Object.entries(schema.properties).filter(([key]) => !softwareFeatureFieldKeys.has(key)),
        ),
      }) as WorkflowObjectSchema,
    [schema],
  );
  const workspaceRequired = schema.required.includes('workspaceRoot');
  const scopeRequired = schema.required.includes('allowedToolScope');
  const scopeSchema = schema.properties.allowedToolScope;
  const scopeMaximum = scopeSchema?.type === 'array' ? scopeSchema.maxItems : 20;

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [workspaceResult, builtinToolsResult, serversResult] = await Promise.allSettled([
        window.cultivation.tools.getWorkspace(),
        window.cultivation.tools.listBuiltins(),
        window.cultivation.tools.listMcpServers(),
      ]);
      if (!active) return;

      const warnings: string[] = [];
      const rootPath =
        workspaceResult.status === 'fulfilled' ? workspaceResult.value.rootPath : null;
      if (workspaceResult.status === 'rejected') {
        warnings.push('无法读取当前 Workspace，请重新选择。');
      }
      const builtinTools =
        builtinToolsResult.status === 'fulfilled'
          ? builtinToolsResult.value.map((tool) => ({ ...tool, name: softwareToolLabel(tool) }))
          : [];
      if (builtinToolsResult.status === 'rejected') {
        warnings.push('无法读取内置工具列表。');
      }

      const discoveredMcpTools: ToolDescriptorView[] = [];
      let failedDiscoveryCount = 0;
      if (serversResult.status === 'fulfilled') {
        const enabledServers = serversResult.value.filter((server) => server.enabled);
        for (const server of enabledServers) {
          try {
            const result = await window.cultivation.tools.refreshMcpServer(server.id);
            if (result.status === 'READY')
              discoveredMcpTools.push(
                ...result.tools.map((tool) => ({
                  ...tool,
                  name: softwareToolLabel(tool, server.name),
                })),
              );
            else failedDiscoveryCount += 1;
          } catch {
            failedDiscoveryCount += 1;
          }
          if (!active) return;
        }
      } else {
        warnings.push('无法读取 MCP 服务列表。');
      }
      if (failedDiscoveryCount) {
        warnings.push(
          `${failedDiscoveryCount} 个已启用 MCP 服务暂不可用；请在“工具”页面连接并检查。`,
        );
      }

      setWorkspaceRoot(rootPath);
      setToolOptions(mergeSoftwareFeatureToolOptions(builtinTools, discoveredMcpTools));
      setLoadingWarnings(warnings);
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const chooseWorkspace = async (): Promise<string | null> => {
    setPickerBusy(true);
    setPickerError('');
    try {
      const selected = await window.cultivation.tools.chooseWorkspace();
      if (!selected.rootPath) return null;
      setWorkspaceRoot(selected.rootPath);
      setValidationError('');
      return selected.rootPath;
    } catch {
      setPickerError('选择 Workspace 失败，请重试。');
      return null;
    } finally {
      setPickerBusy(false);
    }
  };

  const submitOrdinaryInputs = async (ordinaryInputs: WorkflowInputs) => {
    const inputs = {
      ...ordinaryInputs,
      workspaceRoot: workspaceRoot ?? '',
      allowedToolScope: selectedToolIds,
    } as WorkflowInputs;
    try {
      validateWorkflowInputs(schema, inputs);
    } catch {
      setValidationError('请检查必填的 Workspace、工具范围及其他输入项。');
      return;
    }
    setValidationError('');
    await onSubmit(inputs);
  };

  const setToolScope = (ids: string[]) => {
    setSelectedToolIds(ids);
    setValidationError('');
  };

  if (loading) {
    return <div className="loading-card">正在读取 Workspace 与当前可用工具…</div>;
  }

  return (
    <div className="workflow-input-fields software-feature-workflow-input">
      {loadingWarnings.map((warning) => (
        <p className="workflow-input-hint" role="status" key={warning}>
          {warning}
        </p>
      ))}
      <SoftwareFeatureWorkspaceRootField
        value={workspaceRoot}
        required={workspaceRequired}
        disabled={busy}
        pickerBusy={pickerBusy}
        pickerError={pickerError}
        onChooseWorkspace={chooseWorkspace}
        onChange={(rootPath) => {
          setWorkspaceRoot(rootPath);
          setValidationError('');
        }}
      />
      <SoftwareFeatureAllowedToolScopeField
        tools={toolOptions}
        selectedIds={selectedToolIds}
        required={scopeRequired}
        disabled={busy}
        maxItems={scopeMaximum}
        onChange={setToolScope}
      />
      {validationError && (
        <p className="workflow-input-error" role="alert">
          {validationError}
        </p>
      )}
      <WorkflowInputForm
        schema={ordinaryInputSchema}
        presentation={presentation}
        busy={busy}
        onSubmit={submitOrdinaryInputs}
      />
    </div>
  );
}
