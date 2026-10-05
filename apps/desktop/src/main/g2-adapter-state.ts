import type Database from 'better-sqlite3';
import type {
  H3AdapterStateStore,
  H3AdapterSubmissionState,
} from '@cultivation/agent-runtime/h3-generation-gateway';

/** Main-only: preserves the exact upload identities/body across process loss. No credentials. */
export class GenerationAdapterStateStore implements H3AdapterStateStore {
  constructor(private readonly db: Database.Database) {}
  async get(runtimeId: string, key: string): Promise<H3AdapterSubmissionState | null> {
    const row = this.db
      .prepare(
        'SELECT state_json FROM generation_adapter_submissions WHERE runtime_profile_id=? AND idempotency_key=?',
      )
      .get(runtimeId, key) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : null;
  }
  async put(state: H3AdapterSubmissionState): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO generation_adapter_submissions(runtime_profile_id,idempotency_key,state_json) VALUES(?,?,?) ON CONFLICT(runtime_profile_id,idempotency_key) DO UPDATE SET state_json=excluded.state_json',
      )
      .run(state.runtimeId, state.key, JSON.stringify(state));
  }
}
