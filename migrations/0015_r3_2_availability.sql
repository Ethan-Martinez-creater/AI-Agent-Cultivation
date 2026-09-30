-- Current bounded availability projection for each sealed MODEL_RUNTIME
-- identity. It is intentionally not a health-history table and is not attached
-- to benchmarks or USER_BRIDGE teammates.
CREATE TABLE teammate_model_availability (
  teammate_id TEXT PRIMARY KEY
    REFERENCES teammate_model_bindings(teammate_id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL
    REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('UNKNOWN', 'AVAILABLE', 'UNSTABLE', 'UNAVAILABLE')),
  last_checked_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  recent_outcomes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(recent_outcomes_json)
      AND json_type(recent_outcomes_json) = 'array'
      AND json_array_length(recent_outcomes_json) <= 8
      AND length(recent_outcomes_json) <= 4096),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 64),
  CHECK (last_checked_at IS NULL OR length(trim(last_checked_at)) BETWEEN 1 AND 64),
  CHECK (last_success_at IS NULL OR length(trim(last_success_at)) BETWEEN 1 AND 64),
  CHECK (last_failure_at IS NULL OR length(trim(last_failure_at)) BETWEEN 1 AND 64),
  CHECK (
    (status = 'UNKNOWN' AND last_checked_at IS NULL AND last_success_at IS NULL
      AND last_failure_at IS NULL AND recent_outcomes_json = '[]')
    OR (status != 'UNKNOWN' AND last_checked_at IS NOT NULL
      AND json_array_length(recent_outcomes_json) BETWEEN 1 AND 8)
  ),
  CHECK (status != 'AVAILABLE' OR last_success_at IS NOT NULL),
  CHECK (status != 'UNAVAILABLE' OR last_failure_at IS NOT NULL)
);
CREATE INDEX teammate_model_availability_status_idx
  ON teammate_model_availability(status, teammate_id);

-- Legacy model bindings acquire UNKNOWN without claiming a probe occurred.
INSERT INTO teammate_model_availability (
  teammate_id, runtime_profile_id, status, last_checked_at, last_success_at,
  last_failure_at, recent_outcomes_json, policy_version, updated_at
)
SELECT teammate_id, runtime_profile_id, 'UNKNOWN', NULL, NULL, NULL, '[]',
       'r3-2-availability-v1', sealed_at
FROM teammate_model_bindings;

CREATE TRIGGER teammate_model_availability_validate_insert
BEFORE INSERT ON teammate_model_availability
WHEN NOT EXISTS (
    SELECT 1 FROM teammate_model_bindings AS b
    JOIN teammates AS t ON t.id = b.teammate_id
    WHERE b.teammate_id = new.teammate_id
      AND b.runtime_profile_id = new.runtime_profile_id
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = b.runtime_profile_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(new.recent_outcomes_json) AS outcome
    WHERE outcome.type != 'object'
      OR json_type(outcome.value, '$.kind') IS NOT 'text'
      OR json_extract(outcome.value, '$.kind') NOT IN ('SUCCESS', 'HARD_FAILURE', 'TRANSIENT_FAILURE')
      OR json_type(outcome.value, '$.code') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.code'))) NOT BETWEEN 1 AND 80
      OR json_extract(outcome.value, '$.code') GLOB '*[^A-Za-z0-9_.:-]*'
      OR json_type(outcome.value, '$.checkedAt') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.checkedAt'))) NOT BETWEEN 1 AND 64
      OR EXISTS (
        SELECT 1 FROM json_each(outcome.value) AS field
        WHERE field.key NOT IN ('kind', 'code', 'checkedAt')
      )
  ) BEGIN
  SELECT RAISE(ABORT, 'Availability requires the exact sealed MODEL_RUNTIME binding');
END;

-- Every future sealed ordinary ModelBinding starts unknown automatically.
CREATE TRIGGER teammate_model_bindings_availability_insert
AFTER INSERT ON teammate_model_bindings BEGIN
  INSERT INTO teammate_model_availability (
    teammate_id, runtime_profile_id, status, last_checked_at, last_success_at,
    last_failure_at, recent_outcomes_json, policy_version, updated_at
  ) VALUES (
    new.teammate_id, new.runtime_profile_id, 'UNKNOWN', NULL, NULL, NULL, '[]',
    'r3-2-availability-v1', new.sealed_at
  );
END;

-- Credential identity/key rotations invalidate cached availability. Do not
-- retain stale auth results or freshness from the previous key.
CREATE TRIGGER teammate_model_bindings_availability_credential_reset
AFTER UPDATE OF credential_id ON teammate_model_bindings
WHEN new.credential_id IS NOT old.credential_id BEGIN
  UPDATE teammate_model_availability
  SET status = 'UNKNOWN', last_checked_at = NULL, last_success_at = NULL,
      last_failure_at = NULL, recent_outcomes_json = '[]',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE teammate_id = new.teammate_id;
END;

CREATE TRIGGER provider_credentials_availability_key_reset
AFTER UPDATE OF ciphertext ON provider_credentials
WHEN new.ciphertext IS NOT old.ciphertext BEGIN
  UPDATE teammate_model_availability
  SET status = 'UNKNOWN', last_checked_at = NULL, last_success_at = NULL,
      last_failure_at = NULL, recent_outcomes_json = '[]',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE teammate_id IN (
    SELECT teammate_id FROM teammate_model_bindings WHERE credential_id = new.id
  );
END;

CREATE TRIGGER teammate_model_availability_validate_update
BEFORE UPDATE ON teammate_model_availability
WHEN new.teammate_id IS NOT old.teammate_id
  OR new.runtime_profile_id IS NOT old.runtime_profile_id
  OR NOT EXISTS (
    SELECT 1 FROM teammate_model_bindings AS b
    JOIN teammates AS t ON t.id = b.teammate_id
    WHERE b.teammate_id = new.teammate_id
      AND b.runtime_profile_id = new.runtime_profile_id
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = b.runtime_profile_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(new.recent_outcomes_json) AS outcome
    WHERE outcome.type != 'object'
      OR json_type(outcome.value, '$.kind') IS NOT 'text'
      OR json_extract(outcome.value, '$.kind') NOT IN ('SUCCESS', 'HARD_FAILURE', 'TRANSIENT_FAILURE')
      OR json_type(outcome.value, '$.code') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.code'))) NOT BETWEEN 1 AND 80
      OR json_extract(outcome.value, '$.code') GLOB '*[^A-Za-z0-9_.:-]*'
      OR json_type(outcome.value, '$.checkedAt') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.checkedAt'))) NOT BETWEEN 1 AND 64
      OR EXISTS (
        SELECT 1 FROM json_each(outcome.value) AS field
        WHERE field.key NOT IN ('kind', 'code', 'checkedAt')
      )
  ) BEGIN
  SELECT RAISE(ABORT, 'Availability projection has an invalid sealed identity or outcome');
END;

CREATE TRIGGER teammate_model_availability_no_delete
BEFORE DELETE ON teammate_model_availability BEGIN
  SELECT RAISE(ABORT, 'Availability projection is retained for its sealed ModelBinding');
END;
