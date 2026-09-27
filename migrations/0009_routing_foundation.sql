-- R0 adds durable routing facts and the explicit Human Bridge executor.
-- Mission is rebuilt because SQLite cannot extend its state CHECK constraint.

ALTER TABLE teammates ADD COLUMN executor_kind TEXT NOT NULL DEFAULT 'MODEL_RUNTIME'
  CHECK (executor_kind IN ('MODEL_RUNTIME', 'USER_BRIDGE'));
ALTER TABLE teammates ADD COLUMN routing_policy TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (routing_policy IN ('NORMAL', 'FALLBACK_ONLY', 'MANUAL_ONLY'));
ALTER TABLE teammates ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR system_kind = 'HUMAN_BRIDGE');

CREATE UNIQUE INDEX teammates_single_human_bridge_idx
  ON teammates(system_kind) WHERE system_kind = 'HUMAN_BRIDGE';

CREATE TRIGGER teammates_executor_consistency_insert
BEFORE INSERT ON teammates
WHEN (new.executor_kind = 'USER_BRIDGE' AND new.current_runtime_profile_id IS NOT NULL)
  OR (new.system_kind = 'HUMAN_BRIDGE'
    AND (new.executor_kind != 'USER_BRIDGE' OR new.routing_policy != 'FALLBACK_ONLY'
      OR new.current_runtime_profile_id IS NOT NULL)) BEGIN
  SELECT RAISE(ABORT, 'USER_BRIDGE must not bind a Runtime and Human Bridge must remain fallback-only');
END;

CREATE TRIGGER teammates_executor_consistency_update
BEFORE UPDATE OF executor_kind, routing_policy, system_kind, current_runtime_profile_id ON teammates
WHEN (new.executor_kind = 'USER_BRIDGE' AND new.current_runtime_profile_id IS NOT NULL)
  OR (new.system_kind = 'HUMAN_BRIDGE'
    AND (new.executor_kind != 'USER_BRIDGE' OR new.routing_policy != 'FALLBACK_ONLY'
      OR new.current_runtime_profile_id IS NOT NULL)) BEGIN
  SELECT RAISE(ABORT, 'USER_BRIDGE must not bind a Runtime and Human Bridge must remain fallback-only');
END;

CREATE TRIGGER human_bridge_identity_immutable
BEFORE UPDATE OF executor_kind, routing_policy, system_kind, current_runtime_profile_id ON teammates
WHEN old.system_kind = 'HUMAN_BRIDGE'
  AND (new.executor_kind IS NOT old.executor_kind
    OR new.routing_policy IS NOT old.routing_policy
    OR new.system_kind IS NOT old.system_kind
    OR new.current_runtime_profile_id IS NOT old.current_runtime_profile_id) BEGIN
  SELECT RAISE(ABORT, 'Human Bridge executor identity is immutable');
END;

CREATE TRIGGER human_bridge_no_delete BEFORE DELETE ON teammates
WHEN old.system_kind = 'HUMAN_BRIDGE' BEGIN
  SELECT RAISE(ABORT, 'Human Bridge teammate is retained');
END;

DROP TRIGGER missions_permission_scope_delete;
PRAGMA legacy_alter_table = ON;
ALTER TABLE missions RENAME TO missions_r0_old;
CREATE TABLE missions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
  initiator_type TEXT NOT NULL CHECK (initiator_type IN ('USER','TEAMMATE')), initiator_id TEXT NOT NULL,
  coordinator_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  party_id TEXT REFERENCES parties(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('SOLO','CONSULTATION','REVIEW','DELEGATION')),
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT','READY','RUNNING','WAITING_APPROVAL','WAITING_COLLABORATION',
    'WAITING_EXTERNAL_WORK','PAUSED','COMPLETED','FAILED','CANCELLED','INTERRUPTED'
  )),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
INSERT INTO missions (
  id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
  party_id, mode, state, created_at, updated_at, completed_at
)
SELECT
  id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
  party_id, mode, state, created_at, updated_at, completed_at
FROM missions_r0_old;
DROP TABLE missions_r0_old;
PRAGMA legacy_alter_table = OFF;
CREATE INDEX missions_coordinator_idx ON missions(coordinator_teammate_id, created_at);
CREATE TRIGGER missions_permission_scope_delete BEFORE DELETE ON missions
WHEN EXISTS (SELECT 1 FROM permission_rules WHERE scope = 'MISSION' AND scope_id = old.id) BEGIN
  SELECT RAISE(ABORT, 'mission permission scope is still referenced');
END;

CREATE TABLE model_capability_benchmarks (
  id TEXT PRIMARY KEY,
  runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  model_alias TEXT NOT NULL CHECK (length(model_alias) BETWEEN 1 AND 512),
  dimension TEXT NOT NULL CHECK (dimension IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  supported INTEGER NOT NULL CHECK (supported IN (0, 1)),
  normalized_score REAL CHECK (normalized_score BETWEEN 0 AND 100),
  raw_score REAL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 256),
  benchmark TEXT NOT NULL CHECK (length(benchmark) BETWEEN 1 AND 256),
  benchmark_version TEXT NOT NULL CHECK (length(benchmark_version) BETWEEN 1 AND 128),
  snapshot_date TEXT NOT NULL,
  source_url TEXT,
  provenance_type TEXT NOT NULL CHECK (provenance_type IN ('CATALOG','USER_OVERRIDE','USER_ESTIMATE')),
  CHECK ((supported = 0 AND normalized_score IS NULL) OR
         (supported = 1 AND normalized_score IS NOT NULL)),
  UNIQUE (runtime_profile_id, model_alias, dimension, source, benchmark,
          benchmark_version, snapshot_date)
);
CREATE INDEX model_capability_benchmarks_runtime_dimension_idx
  ON model_capability_benchmarks(runtime_profile_id, model_alias, dimension, snapshot_date DESC);
CREATE TRIGGER model_capability_benchmarks_no_update BEFORE UPDATE ON model_capability_benchmarks BEGIN
  SELECT RAISE(ABORT, 'model capability benchmarks are append-only');
END;
CREATE TRIGGER model_capability_benchmarks_no_delete BEFORE DELETE ON model_capability_benchmarks BEGIN
  SELECT RAISE(ABORT, 'model capability benchmarks are append-only');
END;

CREATE TABLE teammate_capability_states (
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  current_score REAL NOT NULL CHECK (current_score BETWEEN 0 AND 100),
  evidence_weight REAL NOT NULL DEFAULT 0 CHECK (evidence_weight >= 0),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  current_runtime_profile_id TEXT REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (teammate_id, dimension)
);
CREATE INDEX teammate_capability_states_dimension_score_idx
  ON teammate_capability_states(dimension, current_score DESC, teammate_id);

CREATE TABLE capability_evidence (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN ('USER_DIMENSION_RATING','USER_OVERALL_RATING')),
  rating_value REAL NOT NULL CHECK (rating_value BETWEEN 0 AND 100),
  demand_weight REAL NOT NULL CHECK (demand_weight >= 0),
  evidence_weight REAL NOT NULL CHECK (evidence_weight >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX capability_evidence_teammate_dimension_idx
  ON capability_evidence(teammate_id, dimension, created_at, id);
CREATE INDEX capability_evidence_mission_run_idx ON capability_evidence(mission_id, run_id);
CREATE TRIGGER capability_evidence_validate_insert
BEFORE INSERT ON capability_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM mission_runs AS r
  JOIN missions AS m ON m.id = r.mission_id
  WHERE r.id = new.run_id AND r.mission_id = new.mission_id
    AND ((m.mode = 'SOLO' AND m.coordinator_teammate_id = new.teammate_id)
      OR EXISTS (SELECT 1 FROM mission_participants AS p
                 WHERE p.mission_id = new.mission_id AND p.teammate_id = new.teammate_id))
) BEGIN
  SELECT RAISE(ABORT, 'capability evidence must belong to a Mission participant and its Run');
END;
CREATE TRIGGER capability_evidence_validate_update
BEFORE UPDATE ON capability_evidence BEGIN
  SELECT RAISE(ABORT, 'capability evidence is append-only');
END;
CREATE TRIGGER capability_evidence_no_delete BEFORE DELETE ON capability_evidence BEGIN
  SELECT RAISE(ABORT, 'capability evidence is append-only');
END;

CREATE TABLE decision_receipts (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT,
  decision_type TEXT NOT NULL CHECK (length(decision_type) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 256),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 512),
  model_version TEXT NOT NULL CHECK (length(model_version) <= 128),
  question_version TEXT NOT NULL CHECK (length(question_version) <= 128),
  state_hash TEXT NOT NULL CHECK (length(state_hash) BETWEEN 1 AND 256),
  input_summary TEXT NOT NULL CHECK (length(input_summary) <= 2000),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json) AND json_type(answers_json) = 'object'),
  confidence_json TEXT NOT NULL CHECK (json_valid(confidence_json) AND json_type(confidence_json) = 'object'),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  selected_action TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('SHADOW','ADVISORY','ACTIVE')),
  created_at TEXT NOT NULL,
  CHECK (run_id IS NULL OR mission_id IS NOT NULL)
);
CREATE INDEX decision_receipts_mission_timeline_idx
  ON decision_receipts(mission_id, created_at, id);
CREATE INDEX decision_receipts_run_idx ON decision_receipts(run_id, created_at, id);
CREATE TRIGGER decision_receipts_validate_insert
BEFORE INSERT ON decision_receipts
WHEN new.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mission_runs AS r
  WHERE r.id = new.run_id AND r.mission_id = new.mission_id
) BEGIN
  SELECT RAISE(ABORT, 'decision receipt Run must belong to its Mission');
END;
CREATE TRIGGER decision_receipts_no_update BEFORE UPDATE ON decision_receipts BEGIN
  SELECT RAISE(ABORT, 'decision receipts are append-only');
END;
CREATE TRIGGER decision_receipts_no_delete BEFORE DELETE ON decision_receipts BEGIN
  SELECT RAISE(ABORT, 'decision receipts are append-only');
END;

CREATE TABLE external_work_requests (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  requester_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  assignee_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  prompt TEXT NOT NULL CHECK (length(prompt) <= 65536),
  requirements_json TEXT NOT NULL CHECK (json_valid(requirements_json) AND json_type(requirements_json) = 'object'),
  target_artifacts_json TEXT NOT NULL CHECK (json_valid(target_artifacts_json) AND json_type(target_artifacts_json) = 'object'),
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING','IN_PROGRESS','SUBMITTED','ACCEPTED','REJECTED','CANCELLED'
  )),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  resolved_at TEXT,
  CHECK (
    (state IN ('PENDING','IN_PROGRESS') AND submitted_at IS NULL AND resolved_at IS NULL)
    OR (state = 'SUBMITTED' AND submitted_at IS NOT NULL AND resolved_at IS NULL)
    OR (state IN ('ACCEPTED','REJECTED') AND submitted_at IS NOT NULL AND resolved_at IS NOT NULL)
    OR (state = 'CANCELLED' AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX external_work_requests_mission_run_state_idx
  ON external_work_requests(mission_id, run_id, state, created_at);
CREATE INDEX external_work_requests_assignee_state_idx
  ON external_work_requests(assignee_teammate_id, state, created_at);
CREATE TRIGGER external_work_requests_validate_insert
BEFORE INSERT ON external_work_requests
WHEN new.state != 'PENDING' OR new.submitted_at IS NOT NULL OR new.resolved_at IS NOT NULL
  OR new.assignee_teammate_id = new.requester_teammate_id
  OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM teammates AS t
    WHERE t.id = new.assignee_teammate_id AND t.executor_kind = 'USER_BRIDGE'
  )
  OR NOT EXISTS (
    SELECT 1 FROM missions AS m
    WHERE m.id = new.mission_id AND (
      m.coordinator_teammate_id = new.requester_teammate_id
      OR EXISTS (SELECT 1 FROM mission_participants AS p
                 WHERE p.mission_id = m.id AND p.teammate_id = new.requester_teammate_id)
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'external work must start pending and match a Mission Run and USER_BRIDGE assignee');
END;
CREATE TRIGGER external_work_requests_transition
BEFORE UPDATE ON external_work_requests
WHEN new.id IS NOT old.id OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id
  OR new.requester_teammate_id IS NOT old.requester_teammate_id
  OR new.assignee_teammate_id IS NOT old.assignee_teammate_id
  OR new.capability IS NOT old.capability OR new.title IS NOT old.title
  OR new.prompt IS NOT old.prompt OR new.requirements_json IS NOT old.requirements_json
  OR new.target_artifacts_json IS NOT old.target_artifacts_json
  OR new.acceptance_criteria_json IS NOT old.acceptance_criteria_json
  OR new.created_at IS NOT old.created_at
  OR NOT (
    (old.state = 'PENDING' AND new.state = 'IN_PROGRESS'
      AND new.submitted_at IS NULL AND new.resolved_at IS NULL)
    OR (old.state = 'PENDING' AND new.state = 'CANCELLED'
      AND new.submitted_at IS NULL AND new.resolved_at IS NOT NULL)
    OR (old.state = 'IN_PROGRESS' AND new.state = 'SUBMITTED'
      AND new.submitted_at IS NOT NULL AND new.resolved_at IS NULL)
    OR (old.state = 'IN_PROGRESS' AND new.state = 'CANCELLED'
      AND new.submitted_at IS NULL AND new.resolved_at IS NOT NULL)
    OR (old.state = 'SUBMITTED' AND new.state IN ('ACCEPTED','REJECTED','CANCELLED')
      AND new.submitted_at IS old.submitted_at AND new.resolved_at IS NOT NULL)
    OR (old.state = 'REJECTED' AND new.state = 'IN_PROGRESS'
      AND new.submitted_at IS NULL AND new.resolved_at IS NULL)
    OR (old.state = 'REJECTED' AND new.state = 'CANCELLED'
      AND new.submitted_at IS old.submitted_at AND new.resolved_at IS NOT NULL)
  ) BEGIN
  SELECT RAISE(ABORT, 'invalid ExternalWorkRequest lifecycle transition');
END;
CREATE TRIGGER external_work_requests_no_delete BEFORE DELETE ON external_work_requests BEGIN
  SELECT RAISE(ABORT, 'external work requests are retained for Mission history');
END;

CREATE TABLE external_work_artifacts (
  id TEXT PRIMARY KEY,
  external_work_request_id TEXT NOT NULL REFERENCES external_work_requests(id) ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 512),
  extension TEXT NOT NULL CHECK (length(extension) <= 32),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  submitted_at TEXT NOT NULL
);
CREATE INDEX external_work_artifacts_request_timeline_idx
  ON external_work_artifacts(external_work_request_id, submitted_at, id);
CREATE TRIGGER external_work_artifacts_validate_insert
BEFORE INSERT ON external_work_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM external_work_requests AS r
  WHERE r.id = new.external_work_request_id AND r.state = 'SUBMITTED'
    AND r.submitted_at = new.submitted_at
) BEGIN
  SELECT RAISE(ABORT, 'external artifacts must belong to the current submission');
END;
CREATE TRIGGER external_work_artifacts_no_update BEFORE UPDATE ON external_work_artifacts BEGIN
  SELECT RAISE(ABORT, 'external work artifacts are append-only');
END;
CREATE TRIGGER external_work_artifacts_no_delete BEFORE DELETE ON external_work_artifacts BEGIN
  SELECT RAISE(ABORT, 'external work artifacts are append-only');
END;

CREATE TABLE external_app_profiles (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  vendor TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (teammate_id, name COLLATE NOCASE)
);
CREATE INDEX external_app_profiles_teammate_enabled_idx
  ON external_app_profiles(teammate_id, enabled, name COLLATE NOCASE);
CREATE TRIGGER external_app_profiles_validate_insert
BEFORE INSERT ON external_app_profiles
WHEN NOT EXISTS (
  SELECT 1 FROM teammates AS t WHERE t.id = new.teammate_id AND t.executor_kind = 'USER_BRIDGE'
) OR EXISTS (
  SELECT 1 FROM json_each(new.capabilities_json) AS j
  WHERE j.type != 'text' OR j.value NOT IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )
) BEGIN
  SELECT RAISE(ABORT, 'external app profiles require a USER_BRIDGE and valid capability dimensions');
END;
CREATE TRIGGER external_app_profiles_validate_update
BEFORE UPDATE ON external_app_profiles
WHEN new.id IS NOT old.id OR new.teammate_id IS NOT old.teammate_id
  OR new.created_at IS NOT old.created_at
  OR NOT EXISTS (
    SELECT 1 FROM teammates AS t WHERE t.id = new.teammate_id AND t.executor_kind = 'USER_BRIDGE'
  ) OR EXISTS (
    SELECT 1 FROM json_each(new.capabilities_json) AS j
    WHERE j.type != 'text' OR j.value NOT IN (
      'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
      'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
      'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'external app profiles require a USER_BRIDGE and valid capability dimensions');
END;
