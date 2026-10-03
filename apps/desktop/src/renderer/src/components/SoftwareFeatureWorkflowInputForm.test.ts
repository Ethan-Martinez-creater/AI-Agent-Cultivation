import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolDescriptorView } from '../ui-shared.js';
import {
  mergeSoftwareFeatureToolOptions,
  SoftwareFeatureAllowedToolScopeField,
  SoftwareFeatureWorkspaceRootField,
  updateSelectedToolIds,
  writeWorkspaceSelectionToInput,
  softwareToolLabel,
} from './SoftwareFeatureWorkflowInputForm.js';

const tools: ToolDescriptorView[] = [
  {
    id: 'builtin:file.readText',
    name: '读取文本文件',
    description: '读取 Workspace 内的文本文件。',
    source: 'BUILTIN',
    capability: 'FILE_READ',
    inputSchema: {},
    riskLevel: 'READ_ONLY',
    sideEffect: false,
  },
  {
    id: 'mcp:verify/run',
    name: '运行固定验证',
    description: '运行已配置的固定验收检查。',
    source: 'MCP',
    capability: 'PROCESS_EXECUTION',
    inputSchema: {},
    riskLevel: 'MEDIUM',
    sideEffect: false,
  },
];

describe('SoftwareFeatureWorkflowInputForm', () => {
  it('shows the selected canonical Workspace as a chooser result, not an editable path', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SoftwareFeatureWorkspaceRootField, {
        value: 'E:\\workspaces\\canonical-project',
        required: true,
        disabled: false,
        pickerBusy: false,
        pickerError: '',
        onChooseWorkspace: async () => null,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('当前已选择 Workspace');
    expect(markup).toContain('E:\\workspaces\\canonical-project');
    expect(markup).toContain('更换 Workspace');
    expect(markup).not.toContain('<input');
  });

  it('writes the canonical root returned by the typed Workspace chooser into the form value', async () => {
    const onChange = vi.fn();
    const chooseWorkspace = vi.fn(async () => 'E:\\workspaces\\picked-canonical-root');

    await writeWorkspaceSelectionToInput(chooseWorkspace, onChange);

    expect(chooseWorkspace).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('E:\\workspaces\\picked-canonical-root');
  });

  it('shows tool names and purposes while placing selected tool IDs in Advanced only', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SoftwareFeatureAllowedToolScopeField, {
        tools,
        selectedIds: ['builtin:file.readText', 'mcp:verify/run'],
        required: true,
        maxItems: 20,
        disabled: false,
        onChange: () => undefined,
      }),
    );
    const advancedStart = markup.indexOf('<details class="advanced-disclosure">');
    const selectionMarkup = markup.slice(0, advancedStart).replace(/<[^>]*>/g, '');
    const advancedMarkup = markup.slice(advancedStart);

    expect(markup).toContain('读取文本文件 · 内置工具');
    expect(markup).toContain('用途：读取 Workspace 内的文本文件。');
    expect(markup).toContain('读取 Workspace 内的文本文件。');
    expect(markup).toContain('运行固定验证 · MCP 工具');
    expect(selectionMarkup).not.toContain('builtin:file.readText');
    expect(selectionMarkup).not.toContain('mcp:verify/run');
    expect(advancedMarkup).toContain('<summary>高级 · 工具 ID</summary>');
    expect(advancedMarkup).toContain('<code>builtin:file.readText</code>');
    expect(advancedMarkup).toContain('<code>mcp:verify/run</code>');
  });

  it('bounds discovered tool descriptions to concise safe text', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SoftwareFeatureAllowedToolScopeField, {
        tools: [{ ...tools[0]!, description: 'x'.repeat(300) }],
        selectedIds: [],
        required: true,
        maxItems: 20,
        disabled: false,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain(`用途：${'x'.repeat(177)}…`);
    expect(markup).not.toContain('x'.repeat(180));
  });
  it('presents a service/tool label instead of the internal MCP descriptor ID', () => {
    expect(
      softwareToolLabel(
        { ...tools[1]!, name: 'mcp.server-uuid.verify_repository', toolName: 'verify_repository' },
        '项目验证工具',
      ),
    ).toBe('项目验证工具 · verify_repository');
    expect(softwareToolLabel({ ...tools[0]!, id: 'file.readText' })).toBe('读取文本');
  });

  it('keeps selected tool identifiers unchanged and merges inventory by identifier', () => {
    expect(updateSelectedToolIds(['prior:tool'], 'mcp:verify/run', true)).toEqual([
      'prior:tool',
      'mcp:verify/run',
    ]);
    expect(updateSelectedToolIds(['prior:tool', 'mcp:verify/run'], 'prior:tool', false)).toEqual([
      'mcp:verify/run',
    ]);
    const merged = mergeSoftwareFeatureToolOptions(
      [tools[0]!],
      [tools[1]!, { ...tools[0]!, name: 'Duplicate' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((tool) => tool.id).sort()).toEqual(
      ['builtin:file.readText', 'mcp:verify/run'].sort(),
    );
    expect(merged.find((tool) => tool.id === 'builtin:file.readText')?.name).toBe('读取文本文件');
  });
});
