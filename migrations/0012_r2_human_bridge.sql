-- R2 keeps Human Bridge capability preferences as configuration facts separate
-- from the derived teammate_capability_states projection.
CREATE TABLE human_bridge_capabilities (
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 64),
  PRIMARY KEY (teammate_id, dimension)
);
CREATE INDEX human_bridge_capabilities_enabled_idx
  ON human_bridge_capabilities(teammate_id, enabled, dimension);

CREATE TRIGGER human_bridge_capabilities_validate_insert
BEFORE INSERT ON human_bridge_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM teammates AS t
  WHERE t.id = new.teammate_id AND t.system_kind = 'HUMAN_BRIDGE'
    AND t.executor_kind = 'USER_BRIDGE' AND t.routing_policy = 'FALLBACK_ONLY'
    AND t.current_runtime_profile_id IS NULL
) BEGIN
  SELECT RAISE(ABORT, 'Human Bridge capability configuration requires the system Human Bridge teammate');
END;
CREATE TRIGGER human_bridge_capabilities_validate_update
BEFORE UPDATE ON human_bridge_capabilities
WHEN new.teammate_id IS NOT old.teammate_id OR new.dimension IS NOT old.dimension
  OR NOT EXISTS (
    SELECT 1 FROM teammates AS t
    WHERE t.id = new.teammate_id AND t.system_kind = 'HUMAN_BRIDGE'
      AND t.executor_kind = 'USER_BRIDGE' AND t.routing_policy = 'FALLBACK_ONLY'
      AND t.current_runtime_profile_id IS NULL
  ) BEGIN
  SELECT RAISE(ABORT, 'Human Bridge capability configuration identity is immutable');
END;
CREATE TRIGGER human_bridge_capabilities_no_delete
BEFORE DELETE ON human_bridge_capabilities BEGIN
  SELECT RAISE(ABORT, 'Human Bridge capability configuration is retained; disable it instead');
END;

-- Disabled dimensions can never remain as a routable capability projection.
CREATE TRIGGER teammate_capability_states_human_bridge_insert
BEFORE INSERT ON teammate_capability_states
WHEN EXISTS (
  SELECT 1 FROM teammates AS t
  WHERE t.id = new.teammate_id AND t.system_kind = 'HUMAN_BRIDGE'
) AND NOT EXISTS (
  SELECT 1 FROM human_bridge_capabilities AS c
  WHERE c.teammate_id = new.teammate_id AND c.dimension = new.dimension AND c.enabled = 1
) BEGIN
  SELECT RAISE(ABORT, 'disabled Human Bridge dimensions cannot have capability state');
END;
CREATE TRIGGER teammate_capability_states_human_bridge_update
BEFORE UPDATE OF teammate_id, dimension ON teammate_capability_states
WHEN EXISTS (
  SELECT 1 FROM teammates AS t
  WHERE t.id = new.teammate_id AND t.system_kind = 'HUMAN_BRIDGE'
) AND NOT EXISTS (
  SELECT 1 FROM human_bridge_capabilities AS c
  WHERE c.teammate_id = new.teammate_id AND c.dimension = new.dimension AND c.enabled = 1
) BEGIN
  SELECT RAISE(ABORT, 'disabled Human Bridge dimensions cannot have capability state');
END;
CREATE TRIGGER human_bridge_capability_disable_state
AFTER UPDATE OF enabled ON human_bridge_capabilities
WHEN old.enabled = 1 AND new.enabled = 0 BEGIN
  DELETE FROM teammate_capability_states
  WHERE teammate_id = new.teammate_id AND dimension = new.dimension;
END;

-- A no-Runtime Human Bridge is an available formal Party participant; every
-- MODEL_RUNTIME member still needs an active Runtime and enabled Provider.
DROP TRIGGER mission_runs_party_available;
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
        AND (t.status != 'ACTIVE' OR (
          NOT (t.system_kind = 'HUMAN_BRIDGE' AND t.executor_kind = 'USER_BRIDGE'
            AND t.routing_policy = 'FALLBACK_ONLY' AND t.current_runtime_profile_id IS NULL)
          AND (t.current_runtime_profile_id IS NULL OR p.enabled != 1)
        ))
    )
  )
) BEGIN
  SELECT RAISE(ABORT, 'Party Mission requires an active Party with two to four available Teammates');
END;

-- Add bounded structured request fields. Existing R0 requests receive an empty
-- path list and no recommendation while all original columns remain intact.
ALTER TABLE external_work_requests
  ADD COLUMN target_workspace_paths_json TEXT NOT NULL DEFAULT '{"items":[]}'
  CHECK (json_valid(target_workspace_paths_json)
    AND json_type(target_workspace_paths_json) = 'object'
    AND json_type(target_workspace_paths_json, '$.items') = 'array');
ALTER TABLE external_work_requests
  ADD COLUMN external_app_profile_id TEXT REFERENCES external_app_profiles(id) ON DELETE RESTRICT;
ALTER TABLE external_work_requests
  ADD COLUMN public_result TEXT
  CHECK (public_result IS NULL OR length(public_result) BETWEEN 1 AND 8000);

DROP TRIGGER external_work_requests_validate_insert;
CREATE TRIGGER external_work_requests_validate_insert
BEFORE INSERT ON external_work_requests
WHEN new.state != 'PENDING' OR new.submitted_at IS NOT NULL OR new.resolved_at IS NOT NULL
  OR new.assignee_teammate_id = new.requester_teammate_id
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

CREATE TRIGGER external_work_requests_r2_fields_immutable
BEFORE UPDATE ON external_work_requests
WHEN new.target_workspace_paths_json IS NOT old.target_workspace_paths_json
  OR new.external_app_profile_id IS NOT old.external_app_profile_id
  OR (new.public_result IS NOT old.public_result AND NOT (
    old.state = 'SUBMITTED' AND new.state = 'ACCEPTED'
      AND old.public_result IS NULL
      AND (new.public_result IS NULL OR length(new.public_result) BETWEEN 1 AND 8000)
  ))
  OR (new.state != 'ACCEPTED' AND new.public_result IS NOT NULL) BEGIN
  SELECT RAISE(ABORT, 'ExternalWorkRequest structured content is immutable');
END;

CREATE TRIGGER external_work_requests_accept_requires_artifact
BEFORE UPDATE OF state ON external_work_requests
WHEN old.state = 'SUBMITTED' AND new.state = 'ACCEPTED'
  AND NOT EXISTS (
    SELECT 1 FROM external_work_artifacts AS a
    WHERE a.external_work_request_id = old.id AND a.submitted_at = old.submitted_at
  ) BEGIN
  SELECT RAISE(ABORT, 'ExternalWorkRequest cannot be accepted without an artifact from its current submission');
END;

-- A resubmission must use a distinct submitted_at value so historical artifacts
-- cannot become current again after a REJECTED -> IN_PROGRESS -> SUBMITTED cycle.
CREATE TRIGGER external_work_requests_submission_timestamp_unique
BEFORE UPDATE OF state, submitted_at ON external_work_requests
WHEN old.state = 'IN_PROGRESS' AND new.state = 'SUBMITTED'
  AND EXISTS (
    SELECT 1 FROM external_work_artifacts AS a
    WHERE a.external_work_request_id = old.id AND a.submitted_at = new.submitted_at
  ) BEGIN
  SELECT RAISE(ABORT, 'ExternalWorkRequest resubmission must use a new timestamp');
END;

-- Capability evidence for the Human Bridge must cite an accepted artifact for
-- the rated capability; USER_BRIDGE is not a general-purpose evidence bypass.
DROP TRIGGER capability_evidence_validate_insert;
CREATE TRIGGER capability_evidence_validate_insert
BEFORE INSERT ON capability_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM mission_runs AS r
  JOIN missions AS m ON m.id = r.mission_id
  JOIN teammates AS t ON t.id = new.teammate_id
  WHERE r.id = new.run_id
    AND r.mission_id = new.mission_id
    AND r.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
    AND (
      (
        t.executor_kind = 'MODEL_RUNTIME'
        AND new.runtime_profile_id IS NOT NULL
        AND (
          m.coordinator_teammate_id = new.teammate_id
          OR EXISTS (
            SELECT 1 FROM mission_participants AS p
            WHERE p.mission_id = new.mission_id AND p.teammate_id = new.teammate_id
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM mission_events AS e
            WHERE e.mission_id = new.mission_id
              AND e.run_id = new.run_id
              AND e.actor_type = 'TEAMMATE'
              AND e.actor_id = new.teammate_id
              AND e.event_type = 'model.call_started'
              AND CASE WHEN json_valid(e.payload_json)
                THEN json_extract(e.payload_json, '$.runtimeProfileId')
                ELSE NULL END = new.runtime_profile_id
          )
          OR EXISTS (
            SELECT 1 FROM usage_records AS u
            WHERE u.mission_id = new.mission_id
              AND u.run_id = new.run_id
              AND u.teammate_id = new.teammate_id
              AND u.runtime_profile_id = new.runtime_profile_id
          )
        )
      )
      OR (
        t.system_kind = 'HUMAN_BRIDGE'
        AND t.executor_kind = 'USER_BRIDGE'
        AND new.runtime_profile_id IS NULL
        AND EXISTS (
          SELECT 1 FROM external_work_requests AS w
          JOIN external_work_artifacts AS a
            ON a.external_work_request_id = w.id AND a.submitted_at = w.submitted_at
          WHERE w.mission_id = new.mission_id
            AND w.run_id = new.run_id
            AND w.assignee_teammate_id = new.teammate_id
            AND w.capability = new.dimension
            AND w.state = 'ACCEPTED'
            AND w.submitted_at IS NOT NULL
            AND w.resolved_at IS NOT NULL
        )
      )
    )
) BEGIN
  SELECT RAISE(ABORT, 'capability evidence requires terminal Run and matching teammate execution provenance');
END;

-- The old ExperienceEvent CHECK excludes EXTERNAL_WORK, so rebuild only that
-- append-only projection and preserve every existing row and index.
DROP TRIGGER experience_events_insert_validate;
DROP TRIGGER experience_events_no_update;
DROP TRIGGER experience_events_no_delete;
CREATE TABLE experience_events_r2 (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  experience_type TEXT NOT NULL CHECK (
    experience_type IN ('MISSION_RESULT', 'COLLABORATION', 'TOOL_USE', 'SKILL_USE', 'EXTERNAL_WORK')
  ),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
  ),
  mode TEXT NOT NULL CHECK (mode IN ('SOLO', 'CONSULTATION', 'REVIEW', 'DELEGATION')),
  created_at TEXT NOT NULL,
  UNIQUE (source, source_id, teammate_id, experience_type)
);
INSERT INTO experience_events_r2
  (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
   role, outcome, mode, created_at)
SELECT id, teammate_id, mission_id, run_id, experience_type, source, source_id,
       role, outcome, mode, created_at
FROM experience_events;
DROP TABLE experience_events;
ALTER TABLE experience_events_r2 RENAME TO experience_events;
CREATE INDEX experience_events_teammate_timeline_idx
  ON experience_events(teammate_id, created_at, id);
CREATE INDEX experience_events_run_idx
  ON experience_events(run_id, experience_type, teammate_id);

CREATE TRIGGER experience_events_insert_validate
BEFORE INSERT ON experience_events
WHEN NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND r.status != 'RUNNING'
      AND new.mode = m.mode
      AND (
        (new.experience_type = 'COLLABORATION' AND (
          (new.outcome = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM mission_events AS s
            JOIN collaboration_requests AS c
              ON c.id = json_extract(s.payload_json, '$.requestId')
             AND c.mission_id = s.mission_id AND c.run_id = s.run_id
             AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
            JOIN mission_events AS t
              ON t.mission_id = s.mission_id AND t.run_id = s.run_id
             AND t.actor_type = 'TEAMMATE' AND t.actor_id = s.actor_id
             AND t.event_type = 'collaboration.completed'
             AND json_extract(t.payload_json, '$.requestId') = c.id
             AND json_extract(t.payload_json, '$.targetTeammateId') = s.actor_id
            WHERE s.id = new.source_id AND s.mission_id = new.mission_id
              AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
              AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
              AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
              AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
              AND NOT EXISTS (
                SELECT 1 FROM mission_events AS other
                WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                  AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                  AND other.event_type = 'collaboration.failed'
                  AND json_extract(other.payload_json, '$.requestId') = c.id
                  AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
              )
          ))
          OR (new.outcome = 'FAILED' AND EXISTS (
            SELECT 1 FROM mission_events AS s
            JOIN collaboration_requests AS c
              ON c.id = json_extract(s.payload_json, '$.requestId')
             AND c.mission_id = s.mission_id AND c.run_id = s.run_id
             AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
            JOIN mission_events AS t
              ON t.mission_id = s.mission_id AND t.run_id = s.run_id
             AND t.actor_type = 'TEAMMATE' AND t.actor_id = s.actor_id
             AND t.event_type = 'collaboration.failed'
             AND json_extract(t.payload_json, '$.requestId') = c.id
             AND json_extract(t.payload_json, '$.targetTeammateId') = s.actor_id
            WHERE s.id = new.source_id AND s.mission_id = new.mission_id
              AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
              AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
              AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
              AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
              AND NOT EXISTS (
                SELECT 1 FROM mission_events AS other
                WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                  AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                  AND other.event_type = 'collaboration.completed'
                  AND json_extract(other.payload_json, '$.requestId') = c.id
                  AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
              )
          ))
          OR (new.outcome IN ('CANCELLED', 'INTERRUPTED')
            AND r.status = new.outcome AND EXISTS (
              SELECT 1 FROM mission_events AS s
              JOIN collaboration_requests AS c
                ON c.id = json_extract(s.payload_json, '$.requestId')
               AND c.mission_id = s.mission_id AND c.run_id = s.run_id
               AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
              WHERE s.id = new.source_id AND s.mission_id = new.mission_id
                AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
                AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
                AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
                AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
                AND NOT EXISTS (
                  SELECT 1 FROM mission_events AS other
                  WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                    AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                    AND other.event_type IN ('collaboration.completed', 'collaboration.failed')
                    AND json_extract(other.payload_json, '$.requestId') = c.id
                    AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
                )
            )
          )
        ))
        OR (new.experience_type = 'EXTERNAL_WORK' AND new.outcome = 'COMPLETED'
          AND new.source = 'EXTERNAL_WORK_REQUEST' AND EXISTS (
            SELECT 1 FROM external_work_requests AS w
            JOIN external_work_artifacts AS a
              ON a.external_work_request_id = w.id AND a.submitted_at = w.submitted_at
            JOIN teammates AS t ON t.id = w.assignee_teammate_id
            WHERE w.id = new.source_id AND w.mission_id = new.mission_id
              AND w.run_id = new.run_id AND w.assignee_teammate_id = new.teammate_id
              AND w.state = 'ACCEPTED' AND t.system_kind = 'HUMAN_BRIDGE'
              AND t.executor_kind = 'USER_BRIDGE'
          ))
        OR (new.experience_type NOT IN ('COLLABORATION', 'EXTERNAL_WORK')
          AND new.outcome = r.status)
      )
      AND (
        (m.mode = 'SOLO' AND new.teammate_id = m.coordinator_teammate_id
          AND new.role = 'COORDINATOR')
        OR (m.mode != 'SOLO' AND m.party_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM mission_participants AS p
          WHERE p.mission_id = m.id AND p.teammate_id = new.teammate_id
            AND p.role = new.role
        ))
      )
  )
  OR (new.experience_type = 'MISSION_RESULT' AND NOT (
    new.source = 'MISSION_RUN' AND new.source_id = new.run_id
      AND EXISTS (
        SELECT 1 FROM missions AS m
        WHERE m.id = new.mission_id AND (
          EXISTS (
            SELECT 1 FROM usage_records AS u
            WHERE u.mission_id = m.id AND u.run_id = new.run_id
              AND u.teammate_id = new.teammate_id
          )
          OR EXISTS (
            SELECT 1 FROM mission_events AS e
            WHERE e.mission_id = m.id AND e.run_id = new.run_id
              AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
              AND (e.event_type = 'model.call_started'
                OR (e.event_type = 'tool.result'
                  AND json_extract(e.payload_json, '$.success') = 1))
          )
          OR EXISTS (
            SELECT 1 FROM collaboration_artifacts AS a
            WHERE a.mission_id = m.id AND a.run_id = new.run_id
              AND a.teammate_id = new.teammate_id
              AND NOT EXISTS (
                SELECT 1 FROM collaboration_requests AS c
                WHERE c.mission_id = a.mission_id AND c.run_id = a.run_id
                  AND c.target_teammate_id = a.teammate_id AND c.state = 'DENIED'
              )
          )
          OR EXISTS (
            SELECT 1 FROM external_work_requests AS w
            JOIN external_work_artifacts AS a
              ON a.external_work_request_id = w.id AND a.submitted_at = w.submitted_at
            WHERE w.mission_id = m.id AND w.run_id = new.run_id
              AND w.assignee_teammate_id = new.teammate_id AND w.state = 'ACCEPTED'
          )
        )
      )
  ))
  OR (new.experience_type = 'COLLABORATION' AND NOT (
    new.source = 'COLLABORATION_EVENT'
  ))
  OR (new.experience_type = 'COLLABORATION' AND NOT EXISTS (
    SELECT 1 FROM missions AS m
    WHERE m.id = new.mission_id AND (
      EXISTS (
        SELECT 1 FROM usage_records AS u
        WHERE u.mission_id = m.id AND u.run_id = new.run_id
          AND u.teammate_id = new.teammate_id
      )
      OR EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.mission_id = m.id AND e.run_id = new.run_id
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
          AND (e.event_type = 'model.call_started'
            OR (e.event_type = 'tool.result'
              AND json_extract(e.payload_json, '$.success') = 1))
      )
      OR EXISTS (
        SELECT 1 FROM collaboration_artifacts AS a
        WHERE a.mission_id = m.id AND a.run_id = new.run_id
          AND a.teammate_id = new.teammate_id
          AND NOT EXISTS (
            SELECT 1 FROM collaboration_requests AS denied
            WHERE denied.mission_id = a.mission_id AND denied.run_id = a.run_id
              AND denied.target_teammate_id = a.teammate_id AND denied.state = 'DENIED'
          )
      )
    )
  ))
  OR (new.experience_type = 'TOOL_USE' AND NOT (
    new.source = 'MISSION_EVENT'
      AND EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.id = new.source_id AND e.mission_id = new.mission_id
          AND e.run_id = new.run_id AND e.event_type = 'tool.result'
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
          AND json_extract(e.payload_json, '$.success') = 1
      )
  ))
  OR (new.experience_type = 'SKILL_USE' AND NOT (
    new.source = 'MISSION_EVENT'
      AND EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.id = new.source_id AND e.mission_id = new.mission_id
          AND e.run_id = new.run_id AND e.event_type = 'skill.used'
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
          AND length(json_extract(e.payload_json, '$.skillId')) > 0
      )
  ))
  OR (new.experience_type = 'EXTERNAL_WORK' AND NOT (
    new.source = 'EXTERNAL_WORK_REQUEST' AND new.outcome = 'COMPLETED'
      AND EXISTS (
        SELECT 1 FROM external_work_requests AS w
        JOIN external_work_artifacts AS a
          ON a.external_work_request_id = w.id AND a.submitted_at = w.submitted_at
        WHERE w.id = new.source_id AND w.mission_id = new.mission_id
          AND w.run_id = new.run_id AND w.assignee_teammate_id = new.teammate_id
          AND w.state = 'ACCEPTED'
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'experience event must match durable Mission, Run, and actor evidence');
END;

CREATE TRIGGER experience_events_no_update BEFORE UPDATE ON experience_events BEGIN
  SELECT RAISE(ABORT, 'experience events are append-only');
END;
CREATE TRIGGER experience_events_no_delete BEFORE DELETE ON experience_events BEGIN
  SELECT RAISE(ABORT, 'experience events are append-only');
END;
