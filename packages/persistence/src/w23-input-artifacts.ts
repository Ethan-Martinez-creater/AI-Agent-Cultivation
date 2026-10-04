import type Database from 'better-sqlite3';
export interface RegisteredInputArtifact {
  id: string;
  category: 'DATA' | 'CODE';
  kind: 'FILE';
  workspaceRoot: string;
  relativePath: string;
  name: string;
  content: string;
  contentHash: string;
  toolCallId: string;
  auditEventId: string;
  createdAt: string;
}
export class ResearchInputArtifactRepository {
  constructor(private readonly db: Database.Database) {}
  insert(value: RegisteredInputArtifact): void {
    this.db
      .prepare(
        `INSERT INTO workflow_input_artifacts(id,category,kind,workspace_root,relative_path,display_name,content,content_hash,tool_call_id,audit_event_id,created_at)
      VALUES(@id,@category,@kind,@workspaceRoot,@relativePath,@name,@content,@contentHash,@toolCallId,@auditEventId,@createdAt)`,
      )
      .run(value);
  }
  list(category: 'DATA' | 'CODE'): RegisteredInputArtifact[] {
    return this.db
      .prepare(
        `SELECT id,category,kind,workspace_root AS workspaceRoot,relative_path AS relativePath,display_name AS name,content,content_hash AS contentHash,tool_call_id AS toolCallId,audit_event_id AS auditEventId,created_at AS createdAt FROM workflow_input_artifacts WHERE category=? ORDER BY created_at DESC,id`,
      )
      .all(category) as RegisteredInputArtifact[];
  }
  get(id: string): RegisteredInputArtifact | null {
    return (
      this.list('DATA')
        .concat(this.list('CODE'))
        .find((a) => a.id === id) ?? null
    );
  }
  bind(value: {
    workflowRunId: string;
    inputKey: string;
    inputIndex: number;
    artifactId: string;
    category: string;
    kind: string;
    contentHash: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO workflow_research_input_bindings(workflow_run_id,input_key,input_index,artifact_id,category,kind,content_hash) VALUES(@workflowRunId,@inputKey,@inputIndex,@artifactId,@category,@kind,@contentHash)',
      )
      .run(value);
  }
  bindings(runId: string) {
    return this.db
      .prepare(
        `SELECT input_key AS inputKey,input_index AS inputIndex,
      artifact_id AS id,kind,content_hash AS contentHash FROM workflow_research_input_bindings
      WHERE workflow_run_id=? AND input_key IN ('existingData','existingCode') ORDER BY input_key,input_index`,
      )
      .all(runId) as Array<{
      inputKey: string;
      inputIndex: number;
      id: string;
      kind: string;
      contentHash: string;
    }>;
  }
}
