import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import type { StepOperationReceipt, WorkflowStepDefinition } from '@cultivation/domain';
import type { WorkflowMissionSnapshot } from '@cultivation/application';
import type { Gate3MissionStore } from '@cultivation/application/gate3-mission-service';
import { FileWorkspace, FileWorkspaceError } from './file-workspace.js';

/** Inspection only. All mutations remain in permission-gated ToolRuntime/Human Bridge. */
export class WorkflowWorkspaceValidation {
  constructor(
    private readonly missions: Pick<Gate3MissionStore, 'listMissionEvents'>,
    private readonly currentRoot: () => string | null,
  ) {}
  private async workspace(boundRoot: string | null): Promise<FileWorkspace> {
    if (!boundRoot || boundRoot !== this.currentRoot())
      throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', 'Workspace 已改变，请恢复原目录');
    return FileWorkspace.open(boundRoot);
  }
  async capture(
    definition: WorkflowStepDefinition,
    boundRoot: string | null,
  ): Promise<StepOperationReceipt['manifest']> {
    if (!['FILE_OUTPUT', 'WORKSPACE_MUTATION'].includes(definition.effectType)) return [];
    const workspace = await this.workspace(boundRoot);
    const manifest: StepOperationReceipt['manifest'] = [];
    for (const path of definition.effectPaths ?? []) {
      let beforeHash: string | undefined;
      try {
        beforeHash = (await workspace.inspectArtifact(path, 10_000_000, true)).contentHash!;
      } catch (error) {
        if (
          !(error instanceof FileWorkspaceError) ||
          error.code !== 'FILE_WORKSPACE_PATH_NOT_FOUND'
        )
          throw error;
      }
      manifest.push({ relativePath: path, ...(beforeHash ? { beforeHash } : {}) });
    }
    return manifest;
  }
  async verify(
    receipt: StepOperationReceipt,
    definition: WorkflowStepDefinition,
    snapshot: WorkflowMissionSnapshot,
    boundRoot: string | null,
  ) {
    if (receipt.effectType === 'NONE') return { verified: true, manifest: [] };
    if (receipt.effectType === 'EXTERNAL_ACTION') {
      // Only user ACCEPT creates this durable success fact; model claims are never evidence.
      const accepted = snapshot.outputs.find((o) => o.source === 'HUMAN_BRIDGE');
      return {
        verified: Boolean(accepted),
        manifest: [],
        ...(accepted ? { externalReference: accepted.sourceId } : {}),
      };
    }
    const workspace = await this.workspace(boundRoot);
    const rootTag = createHash('sha256')
      .update(workspace.getRoot().toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const events = this.missions
      .listMissionEvents(snapshot.mission.id)
      .filter((e) => e.runId === snapshot.run?.id);
    const manifest: StepOperationReceipt['manifest'] = [];
    for (const entry of receipt.manifest ?? []) {
      if (!(definition.effectPaths ?? []).includes(entry.relativePath))
        return { verified: false, manifest: receipt.manifest };
      const resource = `file:${rootTag}:${entry.relativePath.replaceAll('\\', '/').toLowerCase()}`;
      const tool = events.some(
        (e) =>
          e.eventType === 'tool.result' &&
          e.payloadJson.success === true &&
          e.payloadJson.capability === 'FILE_WRITE' &&
          e.payloadJson.resource === resource,
      );
      const external = snapshot.outputs.some(
        (o) => o.source === 'HUMAN_BRIDGE' && o.metadata.path === entry.relativePath,
      );
      if (!tool && !external) return { verified: false, manifest: receipt.manifest };
      const inspected = await workspace.inspectArtifact(entry.relativePath, 10_000_000, true);
      if (
        receipt.state === 'APPLIED' &&
        (!entry.afterHash || entry.afterHash !== inspected.contentHash)
      )
        return { verified: false, manifest: receipt.manifest };
      manifest.push({ ...entry, afterHash: inspected.contentHash! });
    }
    return { verified: manifest.length > 0, manifest };
  }
  async collect(
    snapshot: WorkflowMissionSnapshot,
    definition: WorkflowStepDefinition,
    boundRoot: string | null,
  ): Promise<WorkflowMissionSnapshot> {
    if (!snapshot.run || snapshot.run.status !== 'COMPLETED') return snapshot;
    if (!definition.outputs.some((s) => s.kind === 'FILE' || s.kind === 'DIRECTORY'))
      return snapshot;
    const workspace = await this.workspace(boundRoot);
    const rootTag = createHash('sha256')
      .update(workspace.getRoot().toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const events = this.missions
      .listMissionEvents(snapshot.mission.id)
      .filter((e) => e.runId === snapshot.run!.id);
    for (const path of definition.effectPaths ?? []) {
      const resource = `file:${rootTag}:${path.replaceAll('\\', '/').toLowerCase()}`;
      const evidence = events.find(
        (e) =>
          e.eventType === 'tool.result' &&
          e.payloadJson.success === true &&
          e.payloadJson.capability === 'FILE_WRITE' &&
          e.payloadJson.resource === resource,
      );
      if (!evidence || !evidence.actorId || snapshot.outputs.some((o) => o.metadata.path === path))
        continue;
      const inspected = await workspace.inspectArtifact(path, 10_000_000, true);
      snapshot.outputs.push({
        source: 'MISSION',
        sourceId: evidence.id,
        actorId: evidence.actorId,
        kind: 'FILE',
        content: '',
        metadata: {
          ...inspected,
          contentHash: inspected.contentHash!,
          evidenceEventId: evidence.id,
          permissionResource: resource,
          workspaceTag: rootTag,
        },
      });
    }
    for (const spec of definition.outputs.filter((s) => s.kind === 'DIRECTORY')) {
      const files = snapshot.outputs.filter(
        (o) =>
          o.kind === 'FILE' && (definition.effectPaths ?? []).includes(String(o.metadata.path)),
      );
      if (files.length !== definition.effectPaths?.length || !files.length) continue;
      const entries = files.map((o) => ({
        relativePath: String(o.metadata.path),
        contentHash: String(o.metadata.contentHash),
        sizeBytes: Number(o.metadata.sizeBytes),
      }));
      const content = JSON.stringify({ entries });
      snapshot.outputs.push({
        source: 'MISSION',
        sourceId: snapshot.run.id,
        actorId: snapshot.mission.coordinatorTeammateId,
        kind: 'DIRECTORY',
        content,
        metadata: {
          fileName: spec.key,
          path: '.',
          sizeBytes: Buffer.byteLength(content),
          inspectedManifest: 1,
          workspaceTag: rootTag,
          executionEvidence: JSON.stringify(
            files.map((o) => ({
              relativePath: o.metadata.path,
              source: o.source,
              sourceId: o.sourceId,
              actorId: o.actorId,
            })),
          ),
        },
      });
    }
    return snapshot;
  }
}
