import { isSafeWorkflowRelativePath } from '@cultivation/domain';
import type { ToolResult } from './tool-runtime.js';

/** Optional MCP evidence contract. Retain bounded metadata, never raw tool output. */
export function workflowToolEvidence(result: ToolResult, source: string): Record<string, unknown> {
  if (source !== 'MCP' || !result.ok) return {};
  try {
    const value = JSON.parse(result.content);
    const evidence = value?.structuredContent?.workflowEvidence;
    if (!evidence || typeof evidence !== 'object') return {};
    const hash = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const artifactFiles = Array.isArray(evidence.artifactFiles)
      ? evidence.artifactFiles.slice(0, 20).flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const file = item as Record<string, unknown>;
          return typeof file.path === 'string' &&
            isSafeWorkflowRelativePath(file.path) &&
            hash(file.contentHash)
            ? [{ path: file.path.replaceAll('\\', '/'), contentHash: file.contentHash }]
            : [];
        })
      : [];
    const researchSources = Array.isArray(evidence.researchSources)
      ? evidence.researchSources.slice(0, 20).flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.url !== 'string' || entry.url.length > 1024 || !hash(entry.contentHash))
            return [];
          const url = new URL(entry.url);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            return [];
          return [{ url: url.href, contentHash: entry.contentHash }];
        })
      : [];
    return {
      ...(artifactFiles.length ? { artifactFiles } : {}),
      ...(researchSources.length ? { researchSources } : {}),
    };
  } catch {
    return {};
  }
}
