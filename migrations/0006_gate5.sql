-- Gate 5 adds run-scoped collaboration approval data and immutable public artifacts.
-- Existing Gate 1-4 records are retained; legacy collaboration rows may have no run link.

ALTER TABLE collaboration_requests ADD COLUMN run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT;
ALTER TABLE collaboration_requests ADD COLUMN expected_benefit TEXT NOT NULL DEFAULT ''
  CHECK (length(expected_benefit) <= 4000);
ALTER TABLE collaboration_requests ADD COLUMN depth INTEGER NOT NULL DEFAULT 0
  CHECK (depth IN (0, 1));
ALTER TABLE collaboration_requests ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE collaboration_requests ADD COLUMN resolved_at TEXT;

UPDATE collaboration_requests
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE created_at = '';
UPDATE collaboration_requests
SET resolved_at = created_at
WHERE state != 'PENDING' AND resolved_at IS NULL;

CREATE INDEX collaboration_requests_mission_run_state_idx
  ON collaboration_requests(mission_id, run_id, state, created_at);
CREATE INDEX collaboration_requests_target_state_idx
  ON collaboration_requests(target_teammate_id, state, created_at);

CREATE TRIGGER collaboration_requests_insert_ownership
BEFORE INSERT ON collaboration_requests
WHEN new.run_id IS NULL
  OR new.requester_teammate_id = new.target_teammate_id
  OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM mission_participants
    WHERE mission_id = new.mission_id AND teammate_id = new.requester_teammate_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM mission_participants
    WHERE mission_id = new.mission_id AND teammate_id = new.target_teammate_id
  )
  OR new.depth NOT IN (0, 1)
  OR new.state != 'PENDING' BEGIN
  SELECT RAISE(ABORT, 'collaboration request must link its Mission, Run, and participants and start pending');
END;

CREATE TRIGGER collaboration_requests_resolve_once
BEFORE UPDATE ON collaboration_requests
WHEN old.state != 'PENDING'
  OR new.state NOT IN ('APPROVED', 'DENIED', 'CANCELLED')
  OR new.resolved_at IS NULL
  OR new.id IS NOT old.id
  OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id
  OR new.requester_teammate_id IS NOT old.requester_teammate_id
  OR new.target_teammate_id IS NOT old.target_teammate_id
  OR new.reason IS NOT old.reason
  OR new.proposed_task IS NOT old.proposed_task
  OR new.expected_benefit IS NOT old.expected_benefit
  OR new.depth IS NOT old.depth
  OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'collaboration requests may be resolved once without changing proposal details');
END;

CREATE TRIGGER collaboration_requests_no_delete BEFORE DELETE ON collaboration_requests BEGIN
  SELECT RAISE(ABORT, 'collaboration requests are retained for Mission history');
END;

ALTER TABLE mission_participants ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  CHECK (sort_order >= 0);
UPDATE mission_participants
SET sort_order = (
  SELECT COUNT(*) - 1 FROM mission_participants AS earlier
  WHERE earlier.mission_id = mission_participants.mission_id
    AND earlier.teammate_id <= mission_participants.teammate_id
);
CREATE UNIQUE INDEX mission_participants_order_idx
  ON mission_participants(mission_id, sort_order);
CREATE UNIQUE INDEX mission_participants_single_coordinator_idx
  ON mission_participants(mission_id) WHERE role = 'COORDINATOR';

CREATE TRIGGER mission_participants_validate_insert
BEFORE INSERT ON mission_participants
WHEN new.role NOT IN ('COORDINATOR', 'MEMBER', 'AUTHOR', 'REVIEWER')
  OR (new.role = 'COORDINATOR' AND NOT EXISTS (
    SELECT 1 FROM missions WHERE id = new.mission_id
      AND coordinator_teammate_id = new.teammate_id
  )) BEGIN
  SELECT RAISE(ABORT, 'invalid Mission participant role or coordinator');
END;
CREATE TRIGGER mission_participants_validate_update
BEFORE UPDATE ON mission_participants
WHEN new.role NOT IN ('COORDINATOR', 'MEMBER', 'AUTHOR', 'REVIEWER')
  OR (new.role = 'COORDINATOR' AND NOT EXISTS (
    SELECT 1 FROM missions WHERE id = new.mission_id
      AND coordinator_teammate_id = new.teammate_id
  )) BEGIN
  SELECT RAISE(ABORT, 'invalid Mission participant role or coordinator');
END;

-- Gate 3 allowed only the coordinator to own Mission usage. Party calls are
-- owned by the teammate who actually invoked the model, provided that teammate
-- is a persisted participant of this exact Mission. SOLO retains its original
-- coordinator-only constraint.
DROP TRIGGER usage_records_mission_run_insert;
DROP TRIGGER usage_records_mission_run_update;
CREATE TRIGGER usage_records_mission_run_insert
BEFORE INSERT ON usage_records
WHEN (new.mission_id IS NULL) != (new.run_id IS NULL)
  OR (new.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND (
        (m.mode = 'SOLO' AND m.coordinator_teammate_id = new.teammate_id)
        OR (m.mode IN ('CONSULTATION', 'REVIEW', 'DELEGATION') AND m.party_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM mission_participants AS p
            WHERE p.mission_id = m.id AND p.teammate_id = new.teammate_id
          ))
      )
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
      AND (
        (m.mode = 'SOLO' AND m.coordinator_teammate_id = new.teammate_id)
        OR (m.mode IN ('CONSULTATION', 'REVIEW', 'DELEGATION') AND m.party_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM mission_participants AS p
            WHERE p.mission_id = m.id AND p.teammate_id = new.teammate_id
          ))
      )
  )) BEGIN
  SELECT RAISE(ABORT, 'usage mission, run, and teammate ownership must match');
END;

CREATE TRIGGER mission_runs_party_available
BEFORE INSERT ON mission_runs
WHEN EXISTS (
  SELECT 1 FROM missions AS m
  WHERE m.id = new.mission_id AND m.party_id IS NOT NULL AND (
    NOT EXISTS (
      SELECT 1 FROM parties AS p WHERE p.id = m.party_id AND p.status = 'ACTIVE'
        AND p.coordinator_teammate_id = m.coordinator_teammate_id
    )
    OR (SELECT COUNT(*) FROM party_members WHERE party_id = m.party_id) NOT BETWEEN 2 AND 4
    OR (SELECT COUNT(*) FROM mission_participants WHERE mission_id = m.id) !=
       (SELECT COUNT(*) FROM party_members WHERE party_id = m.party_id)
    OR EXISTS (
      SELECT 1 FROM party_members AS pm
      LEFT JOIN mission_participants AS mp
        ON mp.mission_id = m.id AND mp.teammate_id = pm.teammate_id
      WHERE pm.party_id = m.party_id AND mp.teammate_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM mission_participants AS mp
      LEFT JOIN party_members AS pm
        ON pm.party_id = m.party_id AND pm.teammate_id = mp.teammate_id
      WHERE mp.mission_id = m.id AND pm.teammate_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM mission_participants AS mp
      JOIN teammates AS t ON t.id = mp.teammate_id
      LEFT JOIN runtime_profiles AS rp ON rp.id = t.current_runtime_profile_id
      LEFT JOIN providers AS p ON p.id = rp.provider_id
      WHERE mp.mission_id = m.id
        AND (t.status != 'ACTIVE' OR t.current_runtime_profile_id IS NULL OR p.enabled != 1)
    )
  )
) BEGIN
  SELECT RAISE(ABORT, 'Party Mission requires an active Party with two to four available Teammates');
END;

CREATE TABLE collaboration_artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('MEMBER_RESULT', 'DRAFT', 'REVIEW', 'FINAL')),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  created_at TEXT NOT NULL
);
CREATE INDEX collaboration_artifacts_timeline_idx
  ON collaboration_artifacts(mission_id, run_id, created_at, id);

CREATE TRIGGER collaboration_artifacts_insert_ownership
BEFORE INSERT ON collaboration_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM mission_runs AS r
  JOIN mission_participants AS p ON p.mission_id = r.mission_id
  WHERE r.id = new.run_id AND r.mission_id = new.mission_id
    AND p.teammate_id = new.teammate_id
) BEGIN
  SELECT RAISE(ABORT, 'collaboration artifact must belong to a Mission Run participant');
END;
CREATE TRIGGER collaboration_artifacts_no_update BEFORE UPDATE ON collaboration_artifacts BEGIN
  SELECT RAISE(ABORT, 'collaboration artifacts are append-only');
END;
CREATE TRIGGER collaboration_artifacts_no_delete BEFORE DELETE ON collaboration_artifacts BEGIN
  SELECT RAISE(ABORT, 'collaboration artifacts are append-only');
END;

-- Gate 5 approval continuations remain independent from Gate 4 SOLO tool-call state.
-- The context is a bounded snapshot so a restarted app can resume the same participant/run.
CREATE TABLE gate5_pending_tool_calls (
  approval_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  context_json TEXT NOT NULL CHECK (length(context_json) <= 3145728),
  step_count INTEGER NOT NULL CHECK (step_count >= 0),
  tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RESOLVED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (state = 'PENDING' AND resolved_at IS NULL)
    OR (state = 'RESOLVED' AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX gate5_pending_tool_calls_run_state_idx
  ON gate5_pending_tool_calls(mission_id, run_id, state, created_at);

CREATE TRIGGER gate5_pending_tool_calls_insert_ownership
BEFORE INSERT ON gate5_pending_tool_calls
WHEN new.state != 'PENDING'
  OR new.resolved_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN mission_participants AS p ON p.mission_id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND p.teammate_id = new.teammate_id
  )
  OR NOT (
    EXISTS (
      SELECT 1 FROM approval_requests AS a
      WHERE a.id = new.approval_id AND a.mission_id = new.mission_id
        AND a.run_id = new.run_id AND a.requester_teammate_id = new.teammate_id
        AND a.state = 'PENDING' AND a.resolved_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM collaboration_requests AS c
      WHERE c.id = new.approval_id AND c.mission_id = new.mission_id
        AND c.run_id = new.run_id AND c.target_teammate_id = new.teammate_id
        AND c.state = 'PENDING' AND c.resolved_at IS NULL
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'Gate 5 pending call must match a pending approval for its Mission Run participant');
END;

CREATE TRIGGER gate5_pending_tool_calls_resolve_once
BEFORE UPDATE ON gate5_pending_tool_calls
WHEN old.state != 'PENDING'
  OR new.state != 'RESOLVED'
  OR new.resolved_at IS NULL
  OR new.approval_id IS NOT old.approval_id
  OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id
  OR new.teammate_id IS NOT old.teammate_id
  OR new.context_json IS NOT old.context_json
  OR new.step_count IS NOT old.step_count
  OR new.tool_call_count IS NOT old.tool_call_count
  OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'Gate 5 pending calls may be resolved once without changing continuation data');
END;

CREATE TRIGGER gate5_pending_tool_calls_no_delete BEFORE DELETE ON gate5_pending_tool_calls BEGIN
  SELECT RAISE(ABORT, 'Gate 5 pending calls are retained for Mission history');
END;
