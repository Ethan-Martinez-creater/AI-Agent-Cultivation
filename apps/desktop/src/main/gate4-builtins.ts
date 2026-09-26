import { ToolRegistry } from '@cultivation/application/tool-runtime';
import { createHash } from 'node:crypto';
import { FileWorkspace } from './file-workspace.js';

const BUILTIN_IDS = [
  'file.list',
  'file.readText',
  'file.writeText',
  'file.createDirectory',
] as const;

function resource(input: Record<string, unknown>, rootTag: string, allowRoot = false): string {
  const value = input.path;
  if (typeof value !== 'string' || (!allowRoot && !value.trim())) {
    throw new Error('Invalid path');
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part.includes(':'))
  ) {
    throw new Error('Invalid path');
  }
  return `file:${rootTag}:${normalized.toLowerCase()}`;
}

export function unregisterBuiltins(registry: ToolRegistry): void {
  for (const id of BUILTIN_IDS) registry.unregister(id);
}

export function registerBuiltins(registry: ToolRegistry, workspace: FileWorkspace): void {
  unregisterBuiltins(registry);
  // Permission grants are bound to the selected canonical root as well as the relative path.
  const rootTag = createHash('sha256')
    .update(workspace.getRoot().toLowerCase())
    .digest('hex')
    .slice(0, 16);
  registry.register({
    descriptor: {
      id: 'file.list',
      source: 'BUILTIN',
      name: 'List workspace directory',
      description: 'List files and directories relative to the selected Workspace Root.',
      capability: 'FILE_READ',
      riskLevel: 'READ_ONLY',
      sideEffect: 'NONE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', maxLength: 1024 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    resource: (input) => resource(input, rootTag, true),
    execute: async (input) => {
      const entries = await workspace.list(input.path as string);
      return {
        content: JSON.stringify({
          entries: entries.slice(0, 200),
          truncated: entries.length > 200,
        }),
      };
    },
  });
  registry.register({
    descriptor: {
      id: 'file.readText',
      source: 'BUILTIN',
      name: 'Read workspace text',
      description: 'Read a UTF-8 file relative to the selected Workspace Root (up to 64 KiB).',
      capability: 'FILE_READ',
      riskLevel: 'READ_ONLY',
      sideEffect: 'NONE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    resource: (input) => resource(input, rootTag),
    execute: async (input) => ({ content: await workspace.readText(input.path as string) }),
  });
  registry.register({
    descriptor: {
      id: 'file.writeText',
      source: 'BUILTIN',
      name: 'Write workspace text',
      description: 'Write a UTF-8 file relative to the selected Workspace Root (up to 64 KiB).',
      capability: 'FILE_WRITE',
      riskLevel: 'MEDIUM',
      sideEffect: 'LOCAL_WRITE',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          content: { type: 'string', maxLength: 65_536 },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    resource: (input) => resource(input, rootTag),
    execute: async (input) => {
      await workspace.writeText(input.path as string, input.content as string);
      return { content: 'Text written.' };
    },
  });
  registry.register({
    descriptor: {
      id: 'file.createDirectory',
      source: 'BUILTIN',
      name: 'Create workspace directory',
      description: 'Create a directory relative to the selected Workspace Root.',
      capability: 'FILE_WRITE',
      riskLevel: 'LOW',
      sideEffect: 'LOCAL_WRITE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    resource: (input) => resource(input, rootTag),
    execute: async (input) => {
      await workspace.createDirectory(input.path as string);
      return { content: 'Directory created.' };
    },
  });
}
