import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowImportSource } from '@cultivation/domain';
import type { ToolRuntime } from '@cultivation/application/tool-runtime';
import type { WorkflowImportSourcePort } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';
import { FileWorkspace } from './file-workspace.js';

/** Selected files become bounded snapshots. Their paths never leave Main. */
export class WorkflowImportSources implements WorkflowImportSourcePort {
  constructor(
    private readonly tools: ToolRuntime,
    private readonly root: () => string | null,
  ) {}

  async readSelected(
    selectedAbsolutePath: string,
    consent: () => Promise<boolean>,
  ): Promise<WorkflowImportSource | null> {
    const root = this.root();
    if (!root) throw new DomainError('WORKSPACE_REQUIRED', '请先选择工作目录');
    const workspace = await FileWorkspace.open(root);
    const relativePath = path
      .relative(workspace.getRoot(), selectedAbsolutePath)
      .replaceAll('\\', '/');
    // A native selection is not an escape hatch from the canonical Workspace boundary.
    await workspace.inspectArtifact(relativePath, 65536, false);
    if (!(await consent())) return null;
    if (root !== this.root()) this.invalid();
    const result = await this.tools.dispatchUserRead(
      { id: randomUUID(), toolId: 'file.readText', input: { path: relativePath } },
      'local-user',
      true,
    );
    if (result.kind !== 'RESULT' || !result.result.ok) this.invalid();
    const content = result.result.content;
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const inspection = FileWorkspace.inspectRegisteredInput(workspace.getRoot(), relativePath);
    if (root !== this.root() || inspection.contentHash !== contentHash) this.invalid();
    const kind =
      path.extname(relativePath).toLowerCase() === '.json' ? ('JSON' as const) : ('TEXT' as const);
    if (kind === 'JSON') {
      try {
        JSON.parse(content);
      } catch {
        throw new DomainError('WORKFLOW_INPUT_INVALID', 'JSON 文件无法解析');
      }
    }
    const source: WorkflowImportSource = {
      id: randomUUID(),
      name: path.basename(relativePath),
      relativePath,
      workspaceRoot: workspace.getRoot(),
      kind,
      size: inspection.sizeBytes,
      content,
      contentHash,
      mtime: statSync(path.join(workspace.getRoot(), relativePath)).mtimeMs,
    };
    this.recheck(source);
    return source;
  }

  recheck(source: WorkflowImportSource): void {
    if (
      !this.root() ||
      path.resolve(this.root()!).toLowerCase() !== source.workspaceRoot.toLowerCase()
    )
      this.invalid();
    try {
      const inspection = FileWorkspace.inspectRegisteredInput(
        source.workspaceRoot,
        source.relativePath,
      );
      if (
        inspection.contentHash !== source.contentHash ||
        inspection.sizeBytes !== source.size ||
        statSync(path.join(source.workspaceRoot, source.relativePath)).mtimeMs !== source.mtime
      )
        this.invalid();
    } catch {
      this.invalid();
    }
  }
  private invalid(): never {
    throw new DomainError(
      'WORKFLOW_INPUT_INVALID',
      '来源已改变、无法读取或超出当前工作目录，请重新选择',
    );
  }
}
