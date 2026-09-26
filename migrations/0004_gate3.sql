-- Preserve existing mission runs while adding a bounded result slot for the
-- user-visible runtime result. Hidden reasoning is never stored here.
ALTER TABLE mission_runs ADD COLUMN result_text TEXT;

CREATE INDEX mission_runs_timeline_idx
  ON mission_runs(mission_id, attempt DESC);
CREATE INDEX approval_requests_pending_idx
  ON approval_requests(mission_id, state, created_at);
CREATE INDEX approval_requests_run_timeline_idx
  ON approval_requests(run_id, created_at);
CREATE INDEX mission_events_run_timeline_idx
  ON mission_events(mission_id, run_id, created_at);
CREATE INDEX audit_events_target_timeline_idx
  ON audit_events(target_type, target_id, created_at);
CREATE INDEX usage_records_mission_run_idx
  ON usage_records(mission_id, run_id, created_at);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

-- Approval rows are created pending and may be resolved once. All request
-- details remain immutable while the state is resolved atomically.
CREATE TRIGGER approval_requests_insert_pending
BEFORE INSERT ON approval_requests
WHEN new.state != 'PENDING' OR new.resolved_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'ApprovalRequests must start pending');
END;
CREATE TRIGGER approval_requests_resolve_once
BEFORE UPDATE ON approval_requests
WHEN old.state != 'PENDING'
  OR new.state NOT IN ('APPROVED', 'DENIED', 'CANCELLED', 'EXPIRED')
  OR new.resolved_at IS NULL
  OR new.id IS NOT old.id
  OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id
  OR new.requester_teammate_id IS NOT old.requester_teammate_id
  OR new.capability IS NOT old.capability
  OR new.action_type IS NOT old.action_type
  OR new.action_payload_json IS NOT old.action_payload_json
  OR new.risk_level IS NOT old.risk_level
  OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'ApprovalRequests may be resolved once without changing request details');
END;

-- Mission/run ownership is checked in SQLite too, so a malformed caller cannot
-- associate an event, approval, or usage record with another mission's run.
CREATE TRIGGER approval_requests_run_mission_insert
BEFORE INSERT ON approval_requests
WHEN NOT EXISTS (
  SELECT 1 FROM mission_runs
  WHERE id = new.run_id AND mission_id = new.mission_id
) BEGIN
  SELECT RAISE(ABORT, 'approval run must belong to its mission');
END;
CREATE TRIGGER approval_requests_run_mission_update
BEFORE UPDATE OF mission_id, run_id ON approval_requests
WHEN NOT EXISTS (
  SELECT 1 FROM mission_runs
  WHERE id = new.run_id AND mission_id = new.mission_id
) BEGIN
  SELECT RAISE(ABORT, 'approval run must belong to its mission');
END;

CREATE TRIGGER mission_events_run_mission_insert
BEFORE INSERT ON mission_events
WHEN new.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mission_runs
  WHERE id = new.run_id AND mission_id = new.mission_id
) BEGIN
  SELECT RAISE(ABORT, 'event run must belong to its mission');
END;
CREATE TRIGGER mission_events_run_mission_update
BEFORE UPDATE OF mission_id, run_id ON mission_events
WHEN new.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mission_runs
  WHERE id = new.run_id AND mission_id = new.mission_id
) BEGIN
  SELECT RAISE(ABORT, 'event run must belong to its mission');
END;

CREATE TRIGGER usage_records_mission_run_insert
BEFORE INSERT ON usage_records
WHEN (new.mission_id IS NULL) != (new.run_id IS NULL)
  OR (new.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND m.coordinator_teammate_id = new.teammate_id
  )) BEGIN
  SELECT RAISE(ABORT, 'usage mission, run, and teammate ownership must match');
END;
CREATE TRIGGER usage_records_mission_run_update
BEFORE UPDATE OF mission_id, run_id, teammate_id ON usage_records
WHEN (new.mission_id IS NULL) != (new.run_id IS NULL)
  OR (new.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND m.coordinator_teammate_id = new.teammate_id
  )) BEGIN
  SELECT RAISE(ABORT, 'usage mission, run, and teammate ownership must match');
END;

-- A run is created RUNNING and may be finalized once. The application still
-- verifies transitions; these triggers protect persisted run history.
CREATE TRIGGER mission_runs_insert_running
BEFORE INSERT ON mission_runs WHEN new.status != 'RUNNING' BEGIN
  SELECT RAISE(ABORT, 'mission runs must start in RUNNING');
END;
CREATE TRIGGER mission_runs_terminal_once
BEFORE UPDATE ON mission_runs
WHEN old.status != 'RUNNING'
  OR new.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED') BEGIN
  SELECT RAISE(ABORT, 'mission run can be finalized only once');
END;
