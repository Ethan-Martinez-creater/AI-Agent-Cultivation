-- R4 keeps the existing Cloud SHADOW opt-in and receipt contract untouched.
-- Active task selection has its own explicit opt-in and append-only receipts.
CREATE TABLE routing_policy_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  cloud_enabled INTEGER NOT NULL DEFAULT 0 CHECK (cloud_enabled IN (0, 1)),
  policy_version TEXT NOT NULL CHECK (policy_version = 'r4-controlled-routing-v1'),
  updated_at TEXT NOT NULL
);
INSERT INTO routing_policy_config VALUES
  ('default', 0, 'r4-controlled-routing-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE routing_decision_receipts (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (mode = 'ACTIVE'),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  receipt_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 98304
    AND json_extract(receipt_json, '$.id') = id
    AND json_extract(receipt_json, '$.contextHash') = context_hash
    AND json_extract(receipt_json, '$.outcome') IN ('ASSIGNED', 'USER_ACTION_REQUIRED')
    AND json_extract(receipt_json, '$.policyVersion') = 'r4-controlled-routing-v1'
    AND length(json_extract(receipt_json, '$.taskSummary')) <= 1200
    AND json_type(receipt_json, '$.candidates') = 'array'
    AND json_array_length(receipt_json, '$.candidates') <= 128, 0)
  ),
  created_at TEXT NOT NULL
);
CREATE INDEX routing_receipts_timeline_idx ON routing_decision_receipts(created_at DESC, id);
CREATE TRIGGER routing_receipts_no_update BEFORE UPDATE ON routing_decision_receipts
BEGIN SELECT RAISE(ABORT, 'routing receipts are append-only'); END;
CREATE TRIGGER routing_receipts_no_delete BEFORE DELETE ON routing_decision_receipts
BEGIN SELECT RAISE(ABORT, 'routing receipts are append-only'); END;

CREATE TABLE routing_mission_assignments (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE RESTRICT,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES routing_decision_receipts(id) ON DELETE RESTRICT,
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json) AND length(assignment_json) <= 16000),
  context_json TEXT NOT NULL CHECK (json_valid(context_json) AND length(context_json) <= 24000),
  human_bridge_draft_json TEXT CHECK (human_bridge_draft_json IS NULL OR
    (json_valid(human_bridge_draft_json) AND length(human_bridge_draft_json) <= 32000)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER routing_mission_assignments_provenance BEFORE INSERT ON routing_mission_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM missions AS m JOIN routing_decision_receipts AS r ON r.id = new.receipt_id
  WHERE m.id = new.mission_id
    AND m.coordinator_teammate_id = json_extract(new.assignment_json, '$.coordinatorTeammateId')
    AND m.mode = json_extract(new.assignment_json, '$.mode')
    AND json_extract(new.assignment_json, '$.id') = new.receipt_id
    AND json_extract(r.receipt_json, '$.outcome') = 'ASSIGNED'
    AND json(json_extract(r.receipt_json, '$.assignment')) = json(new.assignment_json)
)
BEGIN SELECT RAISE(ABORT, 'routing assignment must match selected Mission identity'); END;
CREATE TRIGGER routing_mission_assignments_no_update BEFORE UPDATE ON routing_mission_assignments
BEGIN SELECT RAISE(ABORT, 'routing assignments are retained execution facts'); END;
CREATE TRIGGER routing_mission_assignments_no_delete BEFORE DELETE ON routing_mission_assignments
BEGIN SELECT RAISE(ABORT, 'routing assignments are retained execution facts'); END;

-- R4 SOLO fallback is performed by the persistent Human Bridge itself.
-- Permit self-request only for its immutable routed SOLO assignment; retain
-- all R2 content, capability, actor, Run and lifecycle checks verbatim.
DROP TRIGGER external_work_requests_validate_insert;
CREATE TRIGGER external_work_requests_validate_insert
BEFORE INSERT ON external_work_requests
WHEN new.state != 'PENDING' OR new.submitted_at IS NOT NULL OR new.resolved_at IS NOT NULL
  OR (new.assignee_teammate_id = new.requester_teammate_id AND NOT EXISTS (
    SELECT 1 FROM missions AS m
    JOIN routing_mission_assignments AS a ON a.mission_id = m.id
    WHERE m.id = new.mission_id AND m.mode = 'SOLO' AND m.party_id IS NULL
      AND m.coordinator_teammate_id = new.assignee_teammate_id
      AND json_extract(a.assignment_json, '$.kind') = 'HUMAN_BRIDGE'
      AND json_extract(a.assignment_json, '$.coordinatorTeammateId') = new.assignee_teammate_id
      AND a.human_bridge_draft_json IS NOT NULL
  ))
  OR length(trim(new.title)) NOT BETWEEN 1 AND 512
  OR length(trim(new.prompt)) NOT BETWEEN 1 AND 65536
  OR length(new.requirements_json) > 16384
  OR length(new.target_artifacts_json) > 16384
  OR length(new.acceptance_criteria_json) > 16384
  OR json_type(new.requirements_json, '$.items') IS NOT 'array'
  OR json_type(new.acceptance_criteria_json, '$.items') IS NOT 'array'
  OR json_array_length(new.requirements_json, '$.items') > 64
  OR json_array_length(new.acceptance_criteria_json, '$.items') > 64
  OR EXISTS (
    SELECT 1 FROM json_each(new.requirements_json, '$.items') AS p
    WHERE p.type != 'text' OR length(trim(p.value)) NOT BETWEEN 1 AND 2048
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.acceptance_criteria_json, '$.items') AS p
    WHERE p.type != 'text' OR length(trim(p.value)) NOT BETWEEN 1 AND 2048
  )
  OR json_type(new.target_artifacts_json, '$.items') IS NOT 'array'
  OR json_array_length(new.target_artifacts_json, '$.items') NOT BETWEEN 1 AND 32
  OR EXISTS (
    SELECT 1 FROM json_each(new.target_artifacts_json, '$.items') AS i
    WHERE json_type(i.value, '$.id') IS NOT 'text'
      OR length(trim(json_extract(i.value, '$.id'))) NOT BETWEEN 1 AND 128
      OR json_type(i.value, '$.name') IS NOT 'text'
      OR length(trim(json_extract(i.value, '$.name'))) NOT BETWEEN 1 AND 256
      OR (json_type(i.value, '$.required') IS NOT 'true'
        AND json_type(i.value, '$.required') IS NOT 'false')
      OR EXISTS (
        SELECT 1 FROM json_each(i.value) AS field
        WHERE field.key NOT IN ('id', 'name', 'required', 'allowedExtensions', 'maxSizeBytes')
      )
      OR json_type(i.value, '$.allowedExtensions') IS NOT 'array'
      OR json_array_length(i.value, '$.allowedExtensions') NOT BETWEEN 1 AND 32
      OR json_type(i.value, '$.maxSizeBytes') IS NOT 'integer'
      OR json_extract(i.value, '$.maxSizeBytes') NOT BETWEEN 1 AND 1073741824
      OR EXISTS (
        SELECT 1 FROM json_each(i.value, '$.allowedExtensions') AS e
        WHERE e.type != 'text' OR length(trim(e.value)) NOT BETWEEN 1 AND 32
      )
  )
  OR json_array_length(new.target_workspace_paths_json, '$.items') > 32
  OR length(new.target_workspace_paths_json) > 16384
  OR EXISTS (
    SELECT 1 FROM json_each(new.target_workspace_paths_json, '$.items') AS p
    WHERE p.type != 'text' OR length(trim(p.value)) NOT BETWEEN 1 AND 4096
      OR instr('/' || replace(p.value, char(92), '/') || '/', '/../') > 0
  )
  OR new.public_result IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id AND r.status = 'RUNNING'
      AND NOT EXISTS (
        SELECT 1 FROM mission_runs AS newer
        WHERE newer.mission_id = r.mission_id AND newer.attempt > r.attempt
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM teammates AS t
    WHERE t.id = new.assignee_teammate_id AND t.system_kind = 'HUMAN_BRIDGE'
      AND t.executor_kind = 'USER_BRIDGE' AND t.routing_policy = 'FALLBACK_ONLY'
      AND t.current_runtime_profile_id IS NULL
  )
  OR NOT EXISTS (
    SELECT 1 FROM human_bridge_capabilities AS c
    WHERE c.teammate_id = new.assignee_teammate_id
      AND c.dimension = new.capability AND c.enabled = 1
  )
  OR (new.external_app_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM external_app_profiles AS a
    WHERE a.id = new.external_app_profile_id
      AND a.teammate_id = new.assignee_teammate_id AND a.enabled = 1
      AND EXISTS (
        SELECT 1 FROM json_each(a.capabilities_json) AS capability
        WHERE capability.type = 'text' AND capability.value = new.capability
      )
  ))
  OR NOT EXISTS (
    SELECT 1 FROM missions AS m
    WHERE m.id = new.mission_id AND m.state IN ('RUNNING', 'WAITING_EXTERNAL_WORK') AND (
      m.coordinator_teammate_id = new.requester_teammate_id
      OR EXISTS (
        SELECT 1 FROM mission_participants AS p
        WHERE p.mission_id = m.id AND p.teammate_id = new.requester_teammate_id
      )
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'ExternalWorkRequest must have bounded structured content and an enabled Human Bridge capability on its current Mission Run');
END;
