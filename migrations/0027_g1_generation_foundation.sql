-- Merge into migration 0027 before protocol-aware repositories are enabled.
ALTER TABLE runtime_profiles
  ADD COLUMN execution_protocol TEXT NOT NULL DEFAULT 'LANGUAGE'
  CHECK (execution_protocol IN ('LANGUAGE', 'GENERATION'));

ALTER TABLE teammate_model_bindings
  ADD COLUMN execution_protocol TEXT NOT NULL DEFAULT 'LANGUAGE'
  CHECK (execution_protocol IN ('LANGUAGE', 'GENERATION'));

-- Runtime protocol is an immutable identity, including before any teammate is bound.
CREATE TRIGGER runtime_profiles_execution_protocol_immutable
BEFORE UPDATE OF execution_protocol ON runtime_profiles
WHEN new.execution_protocol IS NOT old.execution_protocol BEGIN
  SELECT RAISE(ABORT, 'Runtime execution protocol is immutable');
END;

CREATE TRIGGER teammate_model_bindings_execution_protocol_immutable
BEFORE UPDATE OF execution_protocol ON teammate_model_bindings
WHEN new.execution_protocol IS NOT old.execution_protocol BEGIN
  SELECT RAISE(ABORT, 'Sealed ModelBinding execution protocol is immutable');
END;

CREATE TRIGGER teammate_model_bindings_protocol_matches_runtime
BEFORE INSERT ON teammate_model_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_profiles AS rp
  WHERE rp.id = new.runtime_profile_id
    AND rp.execution_protocol = new.execution_protocol
) BEGIN
  SELECT RAISE(ABORT, 'ModelBinding execution protocol must match its Runtime');
END;
-- G1 Generation persistence DDL. Merge after the identity portion of migration
-- 0027 has added execution_protocol to runtime_profiles and
-- teammate_model_bindings. Existing identities are LANGUAGE by default.

CREATE TABLE generation_tasks (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  target_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  task_json TEXT NOT NULL CHECK (json_valid(task_json) AND json_type(task_json) = 'object'),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json) AND json_type(descriptor_json) = 'object'),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64)
);

CREATE TRIGGER generation_tasks_validate_insert
BEFORE INSERT ON generation_tasks
WHEN json_extract(new.task_json, '$.id') IS NOT new.id
  OR json_extract(new.task_json, '$.targetTeammateId') IS NOT new.target_teammate_id
  OR json_extract(new.task_json, '$.createdAt') IS NOT new.created_at
  OR json_extract(new.task_json, '$.outputDestination.scope') IS NULL
  OR json_extract(new.task_json, '$.outputDestination.scope') NOT IN ('APP_ARTIFACT_STORE', 'MISSION_WORKSPACE')
BEGIN
  SELECT RAISE(ABORT, 'GenerationTask snapshot identity is invalid');
END;

CREATE TRIGGER generation_tasks_immutable
BEFORE UPDATE ON generation_tasks
BEGIN
  SELECT RAISE(ABORT, 'GenerationTask and descriptor snapshots are immutable');
END;

CREATE TRIGGER generation_tasks_no_delete
BEFORE DELETE ON generation_tasks
BEGIN
  SELECT RAISE(ABORT, 'GenerationTask history is retained');
END;

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  generation_task_id TEXT NOT NULL UNIQUE REFERENCES generation_tasks(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  provider_job_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 256),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')),
  provider_status TEXT CHECK (provider_status IS NULL OR length(provider_status) <= 120),
  output_artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_artifact_ids_json) AND json_type(output_artifact_ids_json) = 'array'),
  error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 64),
  completed_at TEXT CHECK (completed_at IS NULL OR length(trim(completed_at)) BETWEEN 1 AND 64),
  UNIQUE (runtime_profile_id, provider_job_id),
  CHECK (state != 'PENDING' OR (provider_job_id IS NULL AND provider_status IS NULL AND error_code IS NULL AND completed_at IS NULL)),
  CHECK ((state = 'COMPLETED' AND completed_at IS NOT NULL) OR (state != 'COMPLETED' AND completed_at IS NULL))
);

CREATE INDEX generation_jobs_state_created ON generation_jobs(state, created_at, id);
CREATE INDEX generation_jobs_teammate_created ON generation_jobs(teammate_id, created_at, id);

CREATE TRIGGER generation_jobs_validate_insert
BEFORE INSERT ON generation_jobs
WHEN new.state != 'PENDING'
  OR new.provider_job_id IS NOT NULL
  OR new.provider_status IS NOT NULL
  OR new.error_code IS NOT NULL
  OR new.completed_at IS NOT NULL
  OR new.output_artifact_ids_json != '[]'
  OR new.idempotency_key != new.generation_task_id
  OR NOT EXISTS (
    SELECT 1
    FROM generation_tasks AS task
    JOIN teammates AS t ON t.id = new.teammate_id
    JOIN runtime_profiles AS rp ON rp.id = new.runtime_profile_id
    JOIN teammate_model_bindings AS binding
      ON binding.teammate_id = t.id AND binding.runtime_profile_id = rp.id
    WHERE task.id = new.generation_task_id
      AND task.target_teammate_id = new.teammate_id
      AND json_extract(task.task_json, '$.targetTeammateId') = new.teammate_id
      AND task.created_at = new.created_at
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = new.runtime_profile_id
      AND rp.execution_protocol = 'GENERATION'
      AND binding.execution_protocol = 'GENERATION'
      AND json_extract(task.descriptor_json, '$.modelId') = rp.model_id
      AND json_extract(task.task_json, '$.capability') = json_extract(task.descriptor_json, '$.outputCapability')
  )
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob requires the teammate current sealed GENERATION Runtime');
END;

CREATE TRIGGER generation_jobs_identity_immutable
BEFORE UPDATE ON generation_jobs
WHEN new.id IS NOT old.id
  OR new.generation_task_id IS NOT old.generation_task_id
  OR new.teammate_id IS NOT old.teammate_id
  OR new.runtime_profile_id IS NOT old.runtime_profile_id
  OR new.idempotency_key IS NOT old.idempotency_key
  OR new.request_fingerprint IS NOT old.request_fingerprint
  OR new.created_at IS NOT old.created_at
  OR (old.provider_job_id IS NOT NULL AND new.provider_job_id IS NOT old.provider_job_id)
  OR (old.provider_job_id IS NULL AND new.provider_job_id IS NOT NULL
      AND (length(trim(new.provider_job_id)) NOT BETWEEN 1 AND 512
      OR old.state != 'SUBMITTING' OR new.state NOT IN ('QUEUED', 'RUNNING')))
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob identity and provider Job identity are immutable');
END;

CREATE TRIGGER generation_jobs_state_guard
BEFORE UPDATE ON generation_jobs
WHEN old.state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')
  OR (old.state != new.state AND NOT (
       (old.state = 'PENDING' AND new.state IN ('SUBMITTING', 'FAILED', 'CANCELLED'))
    OR (old.state = 'SUBMITTING' AND new.state IN ('QUEUED', 'RUNNING', 'UNKNOWN', 'FAILED'))
    OR (old.state = 'QUEUED' AND new.state IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'))
    OR (old.state = 'RUNNING' AND new.state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invalid or terminal GenerationJob state transition');
END;

CREATE TABLE generation_artifacts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE RESTRICT,
  output_id TEXT NOT NULL CHECK (length(trim(output_id)) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 80),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 160),
  extension TEXT NOT NULL CHECK (
    length(extension) BETWEEN 2 AND 13
    AND substr(extension, 1, 1) = '.'
    AND substr(extension, 2) NOT GLOB '*[^a-z0-9]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  storage_scope TEXT NOT NULL CHECK (storage_scope IN ('APP_ARTIFACT_STORE', 'MISSION_WORKSPACE')),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 1024
    AND substr(storage_key, 1, 1) != '/'
    AND substr(storage_key, -1, 1) != '/'
    AND storage_key NOT LIKE '%//%'
    AND instr(storage_key, char(92)) = 0
    AND instr(storage_key, ':') = 0
    AND instr(storage_key, '<') = 0
    AND instr(storage_key, '>') = 0
    AND instr(storage_key, '"') = 0
    AND instr(storage_key, '|') = 0
    AND instr(storage_key, '?') = 0
    AND instr(storage_key, '*') = 0
    AND storage_key NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND storage_key NOT IN ('.', '..')
    AND storage_key NOT LIKE './%'
    AND storage_key NOT LIKE '../%'
    AND storage_key NOT LIKE '%/./%'
    AND storage_key NOT LIKE '%/../%'
    AND storage_key NOT LIKE '%/.'
    AND storage_key NOT LIKE '%/..'
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  UNIQUE (job_id, output_id)
);

CREATE INDEX generation_artifacts_job_created ON generation_artifacts(job_id, created_at, output_id);
CREATE INDEX generation_artifacts_hash ON generation_artifacts(content_hash);

CREATE TRIGGER generation_artifacts_validate_insert
BEFORE INSERT ON generation_artifacts
WHEN NOT EXISTS (
  SELECT 1
  FROM generation_jobs AS job
  JOIN generation_tasks AS task ON task.id = job.generation_task_id
  WHERE job.id = new.job_id
    AND job.state IN ('QUEUED', 'RUNNING')
    AND new.kind = json_extract(task.task_json, '$.expectedOutput.artifactKind')
    AND new.storage_scope = json_extract(task.task_json, '$.outputDestination.scope')
    AND EXISTS (
      SELECT 1 FROM json_each(task.task_json, '$.expectedOutput.mimeTypes') AS expected
      WHERE expected.value = new.mime_type
    )
    AND EXISTS (
      SELECT 1 FROM json_each(task.descriptor_json, '$.outputTypes') AS supported
      WHERE supported.value = new.mime_type
    )
    AND new.size_bytes <= json_extract(task.descriptor_json, '$.limits.maxOutputBytes')
)
BEGIN
  SELECT RAISE(ABORT, 'Output Artifact does not satisfy task, descriptor, or job state');
END;

CREATE TRIGGER generation_artifacts_immutable
BEFORE UPDATE ON generation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Registered output Artifacts are immutable');
END;

CREATE TRIGGER generation_artifacts_no_delete
BEFORE DELETE ON generation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Registered output Artifacts are retained');
END;

CREATE TRIGGER generation_jobs_outputs_guard
BEFORE UPDATE ON generation_jobs
WHEN json_valid(new.output_artifact_ids_json) = 0
  OR json_type(new.output_artifact_ids_json) != 'array'
  OR EXISTS (
    SELECT 1 FROM json_each(old.output_artifact_ids_json) AS old_output
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(new.output_artifact_ids_json) AS new_output
      WHERE new_output.value = old_output.value
    )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.output_artifact_ids_json) AS new_output
    WHERE NOT EXISTS (
      SELECT 1 FROM generation_artifacts AS artifact
      WHERE artifact.id = new_output.value AND artifact.job_id = old.id
    )
  )
  OR EXISTS (
    SELECT value FROM json_each(new.output_artifact_ids_json)
    GROUP BY value HAVING count(*) > 1
  )
  OR (new.state = 'COMPLETED' AND (
       json_array_length(new.output_artifact_ids_json) = 0
       OR json_array_length(new.output_artifact_ids_json) != (
         SELECT count(*) FROM generation_artifacts WHERE job_id = old.id
       )
       OR EXISTS (
         SELECT 1 FROM generation_artifacts AS artifact
         WHERE artifact.job_id = old.id
           AND NOT EXISTS (
             SELECT 1 FROM json_each(new.output_artifact_ids_json) AS output
             WHERE output.value = artifact.id
           )
       )
  ))
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob outputs must be registered, append-only, and complete');
END;

CREATE TRIGGER generation_jobs_no_delete
BEFORE DELETE ON generation_jobs
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob history is retained');
END;

CREATE TABLE generation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE RESTRICT,
  generation_task_id TEXT NOT NULL REFERENCES generation_tasks(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 80),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('PENDING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')),
  to_state TEXT CHECK (to_state IS NULL OR to_state IN ('PENDING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'TEAMMATE', 'WORKFLOW', 'SYSTEM')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 256),
  error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64)
);

CREATE INDEX generation_events_job_created ON generation_events(job_id, id);

CREATE TRIGGER generation_events_validate_insert
BEFORE INSERT ON generation_events
WHEN NOT EXISTS (
  SELECT 1 FROM generation_jobs AS job
  WHERE job.id = new.job_id AND job.generation_task_id = new.generation_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'Generation event must reference its durable task and job');
END;

CREATE TRIGGER generation_events_immutable
BEFORE UPDATE ON generation_events
BEGIN
  SELECT RAISE(ABORT, 'Generation events are append-only');
END;

CREATE TRIGGER generation_events_no_delete
BEFORE DELETE ON generation_events
BEGIN
  SELECT RAISE(ABORT, 'Generation events are append-only');
END;
