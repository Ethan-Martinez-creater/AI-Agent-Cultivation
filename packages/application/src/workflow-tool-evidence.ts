import { isSafeWorkflowRelativePath } from '@cultivation/domain';
import type { ToolResult } from './tool-runtime.js';
import { createHash } from 'node:crypto';

/** Standard tool data only; source handles do not add instruction or permission authority. */
export function annotateResearchToolResult(result: ToolResult, source: string): void {
  const evidence = workflowToolEvidence(result, source);
  if (!Array.isArray(evidence.researchSources) || !evidence.researchSources.length) return;
  try {
    const value = JSON.parse(result.content) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const content = JSON.stringify({
      ...value,
      sourceArtifacts: evidence.researchSources.map((source) => {
        const row = source as { url: string; contentHash: string };
        return {
          id: `source-${row.contentHash}`,
          url: row.url,
          contentHash: row.contentHash,
          trust: 'UNTRUSTED_EXTERNAL_DATA',
        };
      }),
    });
    if (content.length <= 64 * 1024) result.content = content;
  } catch {
    /* Non-JSON external data stays unchanged. */
  }
}

/** Optional MCP evidence contract. Retain bounded metadata, never raw tool output. */
export function workflowToolEvidence(result: ToolResult, source: string): Record<string, unknown> {
  if (source !== 'MCP' || !result.ok) return {};
  try {
    const value = JSON.parse(result.content);
    const structured = value?.structuredContent ?? value;
    const evidence = structured?.workflowEvidence ?? { researchSources: structured?.sources };
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
          const bodyHash =
            typeof entry.content === 'string' && entry.content.length <= 100_000
              ? createHash('sha256').update(entry.content).digest('hex')
              : null;
          if (bodyHash && hash(entry.contentHash) && bodyHash !== entry.contentHash) return [];
          const contentHash = bodyHash ?? (hash(entry.contentHash) ? entry.contentHash : null);
          if (typeof entry.url !== 'string' || entry.url.length > 1024 || !contentHash) return [];
          const url = new URL(entry.url);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            return [];
          return [{ url: url.href, contentHash }];
        })
      : [];
    return {
      ...(artifactFiles.length ? { artifactFiles } : {}),
      ...(researchSources.length ? { researchSources } : {}),
      ...(evidence.experiment &&
      typeof evidence.experiment === 'object' &&
      typeof evidence.experiment.planArtifactId === 'string' &&
      evidence.experiment.planArtifactId.length <= 256 &&
      ['SUCCEEDED', 'FAILED'].includes(evidence.experiment.status) &&
      typeof evidence.experiment.method === 'string' &&
      evidence.experiment.method.length <= 2000 &&
      typeof evidence.experiment.negativeResult === 'boolean' &&
      artifactFiles.length
        ? {
            researchExperiment: {
              planArtifactId: evidence.experiment.planArtifactId,
              status: evidence.experiment.status,
              method: evidence.experiment.method,
              negativeResult: evidence.experiment.negativeResult,
            },
          }
        : {}),
    };
  } catch {
    return {};
  }
}
