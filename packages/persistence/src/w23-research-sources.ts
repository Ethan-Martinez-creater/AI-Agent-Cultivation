import type Database from 'better-sqlite3';
import { DomainError } from '@cultivation/shared';

export interface ResearchSourceFact {
  workflowRunId: string;
  stepRunId: string;
  sourceArtifactId: string;
  missionId: string;
  missionRunId: string;
  evidenceEventId: string;
  actorId: string;
  toolCallId: string;
  toolId: string;
  url: string;
  contentHash: string;
  outputHash: string;
}
/** Materializes only bounded facts already proven by the Main ToolRuntime event ledger. */
export class ResearchSourceRepository {
  constructor(private readonly db: Database.Database) {}
  append(fact: ResearchSourceFact): void {
    const prior = this.db
      .prepare(
        'SELECT url,content_hash,output_hash FROM research_source_artifacts WHERE workflow_run_id=? AND step_run_id=? AND id=?',
      )
      .get(fact.workflowRunId, fact.stepRunId, fact.sourceArtifactId) as
      | { url: string; content_hash: string; output_hash: string }
      | undefined;
    if (prior) {
      if (prior.url !== fact.url || prior.content_hash !== fact.contentHash)
        throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '不可覆盖科研来源');
      return;
    }
    this.db
      .prepare(
        `INSERT INTO research_source_artifacts
      (workflow_run_id,id,step_run_id,mission_id,mission_run_id,event_id,actor_id,tool_call_id,tool_id,url,content_hash,output_hash,created_at)
      VALUES (@workflowRunId,@sourceArtifactId,@stepRunId,@missionId,@missionRunId,@evidenceEventId,@actorId,@toolCallId,@toolId,@url,@contentHash,@outputHash,@createdAt)`,
      )
      .run({ ...fact, createdAt: new Date().toISOString() });
  }
  list(workflowRunId: string): ResearchSourceFact[] {
    return this.db
      .prepare(
        `SELECT workflow_run_id AS workflowRunId,step_run_id AS stepRunId,id AS sourceArtifactId,
      mission_id AS missionId,mission_run_id AS missionRunId,event_id AS evidenceEventId,actor_id AS actorId,
      tool_call_id AS toolCallId,tool_id AS toolId,url,content_hash AS contentHash,output_hash AS outputHash
      FROM research_source_artifacts WHERE workflow_run_id=? ORDER BY created_at,step_run_id,id`,
      )
      .all(workflowRunId) as ResearchSourceFact[];
  }
  resolve(sourceArtifactId: string): ResearchSourceFact | null {
    const row = this.db
      .prepare(
        'SELECT workflow_run_id FROM research_source_artifacts WHERE id=? ORDER BY created_at,workflow_run_id LIMIT 1',
      )
      .get(sourceArtifactId) as { workflow_run_id: string } | undefined;
    return row
      ? (this.list(row.workflow_run_id).find(
          (fact) => fact.sourceArtifactId === sourceArtifactId,
        ) ?? null)
      : null;
  }
}
