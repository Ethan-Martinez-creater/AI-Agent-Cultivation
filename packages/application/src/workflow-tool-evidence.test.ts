import { describe, expect, it } from 'vitest';
import { workflowToolEvidence } from './workflow-tool-evidence.js';

describe('Workflow MCP metadata boundary', () => {
  const result = (workflowEvidence: unknown, ok = true) => ({
    toolCallId: 'c',
    toolId: 'mcp.news',
    ok,
    code: 'OK',
    content: JSON.stringify({ structuredContent: { workflowEvidence }, rawSecret: 'do-not-copy' }),
  });
  it('retains only bounded exact file hashes and research references', () => {
    expect(
      workflowToolEvidence(
        result({
          artifactFiles: [
            { path: 'output/draft.mp4', contentHash: 'a'.repeat(64), secret: 'never' },
          ],
          researchSources: [{ url: 'https://example.test/news', contentHash: 'b'.repeat(64) }],
          unknown: 'never',
        }),
        'MCP',
      ),
    ).toEqual({
      artifactFiles: [{ path: 'output/draft.mp4', contentHash: 'a'.repeat(64) }],
      researchSources: [{ url: 'https://example.test/news', contentHash: 'b'.repeat(64) }],
    });
  });
  it('never treats denied, non-MCP, traversal, secret URL or malformed data as evidence', () => {
    const evidence = {
      artifactFiles: [{ path: '../secret', contentHash: 'a'.repeat(64) }],
      researchSources: [
        { url: 'https://example.test/?apiKey=private', contentHash: 'b'.repeat(64) },
      ],
    };
    expect(workflowToolEvidence(result(evidence), 'MCP')).toEqual({});
    expect(workflowToolEvidence(result(evidence, false), 'MCP')).toEqual({});
    expect(workflowToolEvidence(result(evidence), 'BUILTIN')).toEqual({});
    expect(workflowToolEvidence({ ...result({}), content: 'bad json' }, 'MCP')).toEqual({});
  });
});
