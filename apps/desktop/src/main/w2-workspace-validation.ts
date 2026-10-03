import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import type {
  ArtifactContract,
  StepOperationReceipt,
  WorkflowStepDefinition,
} from '@cultivation/domain';
import type { WorkflowMissionSnapshot } from '@cultivation/application';
import type { Gate3MissionStore } from '@cultivation/application/gate3-mission-service';
import { FileWorkspace, FileWorkspaceError } from './file-workspace.js';

interface WorkspaceMutationFact {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  operationReceiptId: string;
  attempt: number;
  missionId: string;
  missionRunId: string;
  teammateId: string;
  toolCallId: string;
  toolId: 'file.writeText';
  permissionResource: string;
  workspaceTag: string;
  relativePath: string;
  beforeHash: string | null;
  expectedAfterHash: string;
  observedAfterHash: string | null;
  state: 'PREPARED' | 'APPLIED' | 'UNKNOWN';
  resultCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceMutationJournal {
  listMutations(input: {
    workflowRunId: string;
    stepRunId: string;
    missionRunId?: string;
  }): WorkspaceMutationFact[];
  listRunMutations(workflowRunId: string): WorkspaceMutationFact[];
}

interface CheckedMutationPath {
  relativePath: string;
  beforeHash?: string;
  afterHash: string;
  sizeBytes: number;
  workspaceTag: string;
  evidence: Array<{
    relativePath: string;
    source: 'MISSION';
    sourceId: string;
    actorId: string;
    missionRunId: string;
    toolCallId: string;
    permissionResource: string;
    workspaceTag: string;
  }>;
}

/** Inspection only. All mutations remain in permission-gated ToolRuntime/Human Bridge. */
export class WorkflowWorkspaceValidation {
  constructor(
    private readonly missions: Pick<Gate3MissionStore, 'listMissionEvents'>,
    private readonly currentRoot: () => string | null,
    private readonly journal?: WorkspaceMutationJournal,
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
    if (definition.effectPathMode === 'DYNAMIC') {
      await this.workspace(boundRoot);
      return [];
    }
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
    context?: { workflowRunId: string; stepRunId: string },
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
    if (definition.effectPathMode === 'DYNAMIC') {
      if (!context || !this.journal) return { verified: false, manifest: receipt.manifest ?? [] };
      const facts = this.journal.listMutations({
        workflowRunId: context.workflowRunId,
        stepRunId: context.stepRunId,
        ...(snapshot.run?.id ? { missionRunId: snapshot.run.id } : {}),
      });
      const checked = await this.checkMutationFacts(facts, workspace, true);
      if (!checked || !checked.length) return { verified: false, manifest: receipt.manifest ?? [] };
      return {
        verified: true,
        manifest: checked.map((entry) => ({
          relativePath: entry.relativePath,
          ...(entry.beforeHash ? { beforeHash: entry.beforeHash } : {}),
          afterHash: entry.afterHash,
        })),
      };
    }
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
      const mcp = events.some(
        (event) =>
          event.eventType === 'tool.result' &&
          event.payloadJson.success === true &&
          event.payloadJson.source === 'MCP' &&
          event.payloadJson.capability === 'MCP_TOOL_EXECUTE' &&
          Array.isArray(event.payloadJson.artifactFiles) &&
          event.payloadJson.artifactFiles.some(
            (file) =>
              file &&
              typeof file === 'object' &&
              (file as Record<string, unknown>).path === entry.relativePath,
          ),
      );
      const external = snapshot.outputs.some(
        (o) => o.source === 'HUMAN_BRIDGE' && o.metadata.path === entry.relativePath,
      );
      if (!tool && !external && !mcp) return { verified: false, manifest: receipt.manifest };
      const inspected = await workspace.inspectArtifact(entry.relativePath, 10_000_000, true);
      if (
        mcp &&
        !tool &&
        !external &&
        !events.some(
          (event) =>
            event.eventType === 'tool.result' &&
            event.payloadJson.success === true &&
            event.payloadJson.source === 'MCP' &&
            event.payloadJson.capability === 'MCP_TOOL_EXECUTE' &&
            Array.isArray(event.payloadJson.artifactFiles) &&
            event.payloadJson.artifactFiles.some(
              (file) =>
                file &&
                typeof file === 'object' &&
                (file as Record<string, unknown>).path === entry.relativePath &&
                (file as Record<string, unknown>).contentHash === inspected.contentHash,
            ),
        )
      )
        return { verified: false, manifest: receipt.manifest };
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
    context?: { workflowRunId: string; stepRunId: string },
    contractManifest?: readonly ArtifactContract[],
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
      let evidence = events.find(
        (e) =>
          e.eventType === 'tool.result' &&
          e.payloadJson.success === true &&
          e.payloadJson.capability === 'FILE_WRITE' &&
          e.payloadJson.resource === resource,
      );
      const inspected = await workspace.inspectArtifact(path, 10_000_000, true).catch(() => null);
      if (!evidence && inspected)
        evidence = events.find(
          (event) =>
            event.eventType === 'tool.result' &&
            event.payloadJson.success === true &&
            event.payloadJson.source === 'MCP' &&
            event.payloadJson.capability === 'MCP_TOOL_EXECUTE' &&
            Array.isArray(event.payloadJson.artifactFiles) &&
            event.payloadJson.artifactFiles.some(
              (file) =>
                file &&
                typeof file === 'object' &&
                (file as Record<string, unknown>).path === path &&
                (file as Record<string, unknown>).contentHash === inspected.contentHash,
            ),
        );
      if (!evidence || !evidence.actorId || snapshot.outputs.some((o) => o.metadata.path === path))
        continue;
      if (!inspected) continue;
      snapshot.outputs.push({
        source: 'MISSION',
        sourceId: evidence.id,
        actorId: evidence.actorId,
        kind: 'FILE',
        content: '',
        metadata: {
          ...inspected,
          // Keep the frozen contract's separator convention on Windows too.
          path,
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
          ...(definition.artifactPathScope === 'RUN_ATTEMPT' ? { outputKey: spec.key } : {}),
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
    if (context && this.journal) {
      const dynamicStep = definition.effectPathMode === 'DYNAMIC';
      const dynamicDirectorySpecs = definition.outputs.filter((spec) => {
        if (spec.kind !== 'DIRECTORY') return false;
        const contract = contractManifest?.find(
          (item) =>
            item.contractId === spec.contractId && item.contractVersion === spec.contractVersion,
        );
        return (
          contract?.validator.type === 'WORKSPACE_MANIFEST' &&
          contract.validator.dynamicPaths === true
        );
      });
      if (dynamicStep || dynamicDirectorySpecs.length) {
        const facts = dynamicStep
          ? this.journal.listMutations({
              workflowRunId: context.workflowRunId,
              stepRunId: context.stepRunId,
              missionRunId: snapshot.run.id,
            })
          : this.journal.listRunMutations(context.workflowRunId);
        const checked = await this.checkMutationFacts(facts, workspace, true);
        if ((!checked || !checked.length) && dynamicDirectorySpecs.some((spec) => spec.required))
          throw new DomainError(
            'WORKFLOW_MUTATION_INCOMPLETE',
            'No verified Workspace changes are available',
          );
        for (const spec of dynamicDirectorySpecs) {
          if (
            !checked?.length ||
            snapshot.outputs.some((item) => item.metadata.outputKey === spec.key)
          )
            continue;
          const entries = checked.map((entry) => ({
            relativePath: entry.relativePath,
            ...(entry.beforeHash ? { beforeHash: entry.beforeHash } : {}),
            afterHash: entry.afterHash,
          }));
          const content = JSON.stringify({ entries });
          const evidence = checked.flatMap((entry) => entry.evidence);
          snapshot.outputs.push({
            source: 'MISSION',
            sourceId: snapshot.run.id,
            actorId: snapshot.mission.coordinatorTeammateId,
            kind: 'DIRECTORY',
            content,
            metadata: {
              fileName: spec.key,
              outputKey: spec.key,
              path: '.',
              sizeBytes: Buffer.byteLength(content),
              inspectedManifest: 1,
              workspaceTag: checked[0]!.workspaceTag,
              executionEvidence: JSON.stringify(evidence),
            },
          });
        }
      }
    }
    return snapshot;
  }

  private async checkMutationFacts(
    facts: readonly WorkspaceMutationFact[],
    workspace: FileWorkspace,
    requireResultEvents: boolean,
  ): Promise<CheckedMutationPath[] | null> {
    if (!facts.length || facts.some((fact) => fact.state !== 'APPLIED' || !fact.observedAfterHash))
      return null;
    const tag = createHash('sha256')
      .update(workspace.getRoot().toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const byPath = new Map<string, WorkspaceMutationFact[]>();
    for (const fact of facts) {
      if (
        fact.workspaceTag !== tag ||
        fact.toolId !== 'file.writeText' ||
        fact.permissionResource !== `file:${tag}:${fact.relativePath.toLowerCase()}` ||
        !isSafeWorkflowPath(fact.relativePath)
      )
        return null;
      const rows = byPath.get(fact.relativePath) ?? [];
      rows.push(fact);
      byPath.set(fact.relativePath, rows);
    }
    const eventCache = new Map<string, ReturnType<Gate3MissionStore['listMissionEvents']>>();
    const checked: CheckedMutationPath[] = [];
    for (const [relativePath, pathFacts] of [...byPath.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      pathFacts.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
      for (let index = 1; index < pathFacts.length; index += 1)
        if (pathFacts[index]!.beforeHash !== pathFacts[index - 1]!.observedAfterHash) return null;
      const latest = pathFacts.at(-1)!;
      const inspected = await workspace
        .inspectArtifact(relativePath, 10_000_000, true)
        .catch(() => null);
      if (!inspected?.contentHash || inspected.contentHash !== latest.observedAfterHash)
        return null;
      const evidence: CheckedMutationPath['evidence'] = [];
      for (const fact of pathFacts) {
        if (!requireResultEvents) continue;
        const events =
          eventCache.get(fact.missionId) ?? this.missions.listMissionEvents(fact.missionId);
        eventCache.set(fact.missionId, events);
        const event = events.find(
          (candidate) =>
            candidate.runId === fact.missionRunId &&
            candidate.eventType === 'tool.result' &&
            candidate.actorId === fact.teammateId &&
            candidate.payloadJson.success === true &&
            candidate.payloadJson.toolCallId === fact.toolCallId &&
            candidate.payloadJson.toolId === fact.toolId &&
            candidate.payloadJson.capability === 'FILE_WRITE' &&
            candidate.payloadJson.resource === fact.permissionResource,
        );
        if (!event) return null;
        evidence.push({
          relativePath,
          source: 'MISSION',
          sourceId: event.id,
          actorId: fact.teammateId,
          missionRunId: fact.missionRunId,
          toolCallId: fact.toolCallId,
          permissionResource: fact.permissionResource,
          workspaceTag: fact.workspaceTag,
        });
      }
      const first = pathFacts[0]!;
      checked.push({
        relativePath,
        ...(first.beforeHash ? { beforeHash: first.beforeHash } : {}),
        afterHash: latest.observedAfterHash!,
        sizeBytes: inspected.sizeBytes,
        workspaceTag: tag,
        evidence,
      });
    }
    return checked;
  }
}

function isSafeWorkflowPath(value: string): boolean {
  const path = value.replaceAll('\\', '/');
  return (
    path === value &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  );
}
