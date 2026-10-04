import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResearchArtifactPicker } from './ResearchWorkflowInputForm.js';
describe('research input Artifact selector', () => {
  it('renders only trusted candidate names and choices, not editable identity fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(ResearchArtifactPicker, {
        label: '已有数据',
        candidates: [
          {
            id: 'input-main-owned',
            kind: 'FILE',
            name: 'dataset.csv',
            contentHash: 'a'.repeat(64),
          },
        ],
        selected: [],
        busy: false,
        onChange: () => {},
        onImport: () => {},
      }),
    );
    expect(html).toContain('dataset.csv');
    expect(html).toContain('导入数据');
    expect(html).not.toContain('input-main-owned');
    expect(html).not.toContain('引用 ID');
    expect(html).not.toContain('type="text"');
  });
});
