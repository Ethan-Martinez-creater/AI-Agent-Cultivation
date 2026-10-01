import type Database from 'better-sqlite3';
import type {
  RoutingDecisionReceipt,
  RoutingTaskContext,
  TaskExecutionAssignment,
} from '@cultivation/domain';
import type { CreateExplicitExternalWorkInput } from '@cultivation/application/r2-human-bridge-service';

export type RoutingHumanBridgeDraft = Omit<
  CreateExplicitExternalWorkInput,
  'missionId' | 'runId' | 'requesterTeammateId'
>;
export interface RoutingMissionAssignmentRecord {
  missionId: string;
  receiptId: string;
  assignment: TaskExecutionAssignment;
  context: RoutingTaskContext;
  externalWorkDraft: RoutingHumanBridgeDraft | null;
  createdAt: string;
}

export class R4RoutingRepository {
  constructor(private readonly db: Database.Database) {}
  config(): { cloudEnabled: boolean; policyVersion: string } {
    const row = this.db
      .prepare('SELECT cloud_enabled, policy_version FROM routing_policy_config WHERE id = ?')
      .get('default') as { cloud_enabled: number; policy_version: string };
    return { cloudEnabled: row.cloud_enabled === 1, policyVersion: row.policy_version };
  }
  setCloudEnabled(value: boolean) {
    this.db
      .prepare('UPDATE routing_policy_config SET cloud_enabled = ?, updated_at = ? WHERE id = ?')
      .run(value ? 1 : 0, new Date().toISOString(), 'default');
    return this.config();
  }
  appendRoutingReceipt(receipt: RoutingDecisionReceipt): void {
    this.db
      .prepare(
        'INSERT INTO routing_decision_receipts (id, context_hash, receipt_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(receipt.id, receipt.contextHash, JSON.stringify(receipt), receipt.createdAt);
  }
  listReceipts(missionId?: string): RoutingDecisionReceipt[] {
    const rows = (
      missionId
        ? this.db
            .prepare(
              'SELECT r.receipt_json FROM routing_decision_receipts AS r JOIN routing_mission_assignments AS a ON a.receipt_id = r.id WHERE a.mission_id = ? ORDER BY r.created_at DESC, r.id LIMIT 100',
            )
            .all(missionId)
        : this.db
            .prepare(
              'SELECT receipt_json FROM routing_decision_receipts ORDER BY created_at DESC, id LIMIT 100',
            )
            .all()
    ) as Array<{ receipt_json: string }>;
    return rows.map((row) => JSON.parse(row.receipt_json) as RoutingDecisionReceipt);
  }
  saveAssignment(value: RoutingMissionAssignmentRecord): void {
    this.db
      .prepare(
        'INSERT INTO routing_mission_assignments (mission_id, receipt_id, assignment_json, context_json, human_bridge_draft_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        value.missionId,
        value.receiptId,
        JSON.stringify(value.assignment),
        JSON.stringify(value.context),
        value.externalWorkDraft ? JSON.stringify(value.externalWorkDraft) : null,
        value.createdAt,
      );
  }
  getByMissionId(missionId: string): RoutingMissionAssignmentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM routing_mission_assignments WHERE mission_id = ?')
      .get(missionId) as
      | {
          mission_id: string;
          receipt_id: string;
          assignment_json: string;
          context_json: string;
          human_bridge_draft_json: string | null;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          missionId: row.mission_id,
          receiptId: row.receipt_id,
          assignment: JSON.parse(row.assignment_json),
          context: JSON.parse(row.context_json),
          externalWorkDraft: row.human_bridge_draft_json
            ? JSON.parse(row.human_bridge_draft_json)
            : null,
          createdAt: row.created_at,
        }
      : null;
  }
}
