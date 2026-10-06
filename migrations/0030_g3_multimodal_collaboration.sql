-- G3 provider-neutral execution tasks, immutable participant outcomes, and continuations.
-- Existing GenerationJob state machines remain owned by migrations 0027-0029.

CREATE TABLE g3_execution_tasks (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  logical_key TEXT NOT NULL CHECK (length(trim(logical_key)) BETWEEN 1 AND 256),
  source TEXT NOT NULL CHECK (source IN ('COLLABORATION', 'WORKFLOW')),
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  collaboration_request_id TEXT REFERENCES collaboration_requests(id) ON DELETE RESTRICT,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_step_run_id TEXT REFERENCES workflow_step_runs(id) ON DELETE RESTRICT,
  requester_teammate_id TEXT REFERENCES teammates(id) ON DELETE RESTRICT,
  coordinator_teammate_id TEXT REFERENCES teammates(id) ON DELETE RESTRICT,
  target_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  required_capability TEXT NOT NULL CHECK (required_capability IN (
    'GENERAL_REASONING','LONG_CONTEXT_REASONING','AGENTIC_EXECUTION','CODING','TOOL_USE',
    'VISUAL_UNDERSTANDING','IMAGE_GENERATION','IMAGE_EDITING','VIDEO_GENERATION','VIDEO_EDITING',
    'SPEECH_UNDERSTANDING','SPEECH_GENERATION','SPEECH_TO_SPEECH','MUSIC_GENERATION'
  )),
  execution_protocol TEXT NOT NULL CHECK (execution_protocol IN ('LANGUAGE', 'GENERATION', 'USER_BRIDGE')),
  parent_task_id TEXT REFERENCES g3_execution_tasks(id) ON DELETE RESTRICT,
  retry_no INTEGER NOT NULL CHECK (retry_no BETWEEN 0 AND 1),
  continuation_round INTEGER NOT NULL CHECK (continuation_round BETWEEN 0 AND 3),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  task_json TEXT NOT NULL CHECK (
    json_valid(task_json) AND json_type(task_json) = 'object'
      AND length(CAST(task_json AS BLOB)) <= 65536
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  UNIQUE (logical_key, retry_no),
  CHECK (retry_no = 0 OR parent_task_id IS NOT NULL)
);

CREATE INDEX g3_execution_tasks_mission_run ON g3_execution_tasks(mission_id, run_id, created_at, id);
CREATE INDEX g3_execution_tasks_parent ON g3_execution_tasks(parent_task_id, continuation_round, id);
CREATE INDEX g3_execution_tasks_target ON g3_execution_tasks(target_teammate_id, created_at, id);

CREATE TRIGGER g3_execution_tasks_validate_insert
BEFORE INSERT ON g3_execution_tasks
WHEN json_extract(new.task_json, '$.id') IS NOT new.id
  OR EXISTS (
    SELECT 1 FROM json_each(new.task_json) AS field
    WHERE field.key NOT IN (
      'id','logicalKey','source','missionId','runId','collaborationRequestId','workflowRunId',
      'workflowStepRunId','requesterTeammateId','coordinatorTeammateId','targetTeammateId',
      'requiredCapability','executionProtocol','publicTask','publicContext','artifactInputs',
      'generationRequirements','acceptanceCriteria','inputRequirements','dependencyRole','reviewOf',
      'parentTaskId','retryNo','continuationRound','policyVersion','createdAt'
    )
  )
  OR json_extract(new.task_json, '$.logicalKey') IS NOT new.logical_key
  OR json_extract(new.task_json, '$.source') IS NOT new.source
  OR json_extract(new.task_json, '$.missionId') IS NOT new.mission_id
  OR json_extract(new.task_json, '$.runId') IS NOT new.run_id
  OR json_extract(new.task_json, '$.collaborationRequestId') IS NOT new.collaboration_request_id
  OR json_extract(new.task_json, '$.workflowRunId') IS NOT new.workflow_run_id
  OR json_extract(new.task_json, '$.workflowStepRunId') IS NOT new.workflow_step_run_id
  OR json_extract(new.task_json, '$.requesterTeammateId') IS NOT new.requester_teammate_id
  OR json_extract(new.task_json, '$.coordinatorTeammateId') IS NOT new.coordinator_teammate_id
  OR json_extract(new.task_json, '$.targetTeammateId') IS NOT new.target_teammate_id
  OR json_extract(new.task_json, '$.requiredCapability') IS NOT new.required_capability
  OR json_extract(new.task_json, '$.executionProtocol') IS NOT new.execution_protocol
  OR json_extract(new.task_json, '$.parentTaskId') IS NOT new.parent_task_id
  OR json_extract(new.task_json, '$.retryNo') IS NOT new.retry_no
  OR json_extract(new.task_json, '$.continuationRound') IS NOT new.continuation_round
  OR json_extract(new.task_json, '$.policyVersion') IS NOT new.policy_version
  OR json_extract(new.task_json, '$.createdAt') IS NOT new.created_at
  OR json_type(new.task_json, '$.artifactInputs') IS NOT 'array'
  OR json_array_length(new.task_json, '$.artifactInputs') > 32
  OR json_type(new.task_json, '$.acceptanceCriteria') IS NOT 'array'
  OR json_array_length(new.task_json, '$.acceptanceCriteria') > 16
  OR EXISTS (
    SELECT 1 FROM json_each(new.task_json, '$.artifactInputs') AS input
    WHERE json_type(input.value, '$.role') IS NOT 'text'
      OR NOT EXISTS (
        SELECT 1 FROM g3_artifact_refs AS artifact
        WHERE artifact.mission_id = new.mission_id AND artifact.run_id = new.run_id
          AND artifact.artifact_id = json_extract(input.value, '$.id')
          AND artifact.kind = json_extract(input.value, '$.kind')
          AND artifact.mime_type = json_extract(input.value, '$.mimeType')
          AND artifact.content_hash = lower(json_extract(input.value, '$.contentHash'))
          AND artifact.size_bytes = json_extract(input.value, '$.sizeBytes')
      )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.task_json, '$.reviewOf') AS reviewed
    WHERE NOT EXISTS (
      SELECT 1 FROM g3_artifact_refs AS artifact
      WHERE artifact.mission_id = new.mission_id AND artifact.run_id = new.run_id
        AND artifact.artifact_id = json_extract(reviewed.value, '$.id')
        AND artifact.kind = json_extract(reviewed.value, '$.kind')
        AND artifact.mime_type = json_extract(reviewed.value, '$.mimeType')
        AND artifact.content_hash = lower(json_extract(reviewed.value, '$.contentHash'))
        AND artifact.size_bytes = json_extract(reviewed.value, '$.sizeBytes')
    )
  )
  OR length(COALESCE(json_extract(new.task_json, '$.publicTask'), '')) NOT BETWEEN 1 AND 4000
  OR length(COALESCE(json_extract(new.task_json, '$.publicContext'), '')) > 12000
  OR (new.source = 'COLLABORATION' AND (
       new.collaboration_request_id IS NULL
    OR new.workflow_run_id IS NOT NULL OR new.workflow_step_run_id IS NOT NULL
    OR new.requester_teammate_id IS NULL OR new.coordinator_teammate_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM collaboration_requests AS request
      WHERE request.id = new.collaboration_request_id
        AND request.state = 'APPROVED'
        AND request.mission_id = new.mission_id AND request.run_id = new.run_id
        AND request.requester_teammate_id = new.requester_teammate_id
        AND request.target_teammate_id = new.target_teammate_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM missions AS mission
      WHERE mission.id = new.mission_id
        AND mission.coordinator_teammate_id = new.coordinator_teammate_id
    )
  ))
  OR (new.source = 'WORKFLOW' AND (
       new.collaboration_request_id IS NOT NULL
    OR json_extract(new.task_json, '$.collaborationRequestId') IS NOT NULL
    OR new.workflow_run_id IS NULL OR new.workflow_step_run_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM workflow_step_runs AS step
      WHERE step.id = new.workflow_step_run_id
        AND step.workflow_run_id = new.workflow_run_id
        AND step.mission_id = new.mission_id
        AND (step.mission_run_id IS NULL OR step.mission_run_id = new.run_id)
    )
  ))
  OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS run
    WHERE run.id = new.run_id AND run.mission_id = new.mission_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM mission_participants AS participant
    WHERE participant.mission_id = new.mission_id AND participant.teammate_id = new.target_teammate_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM teammates AS target
    WHERE target.id = new.target_teammate_id
      AND ((new.execution_protocol = 'USER_BRIDGE' AND target.executor_kind = 'USER_BRIDGE'
          AND target.status = 'ACTIVE' AND target.system_kind = 'HUMAN_BRIDGE'
          AND target.routing_policy = 'FALLBACK_ONLY' AND target.current_runtime_profile_id IS NULL)
        OR (new.execution_protocol IN ('LANGUAGE','GENERATION')
          AND target.executor_kind = 'MODEL_RUNTIME' AND target.system_kind IS NULL
          AND target.current_runtime_profile_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM runtime_profiles AS runtime
            JOIN teammate_model_bindings AS binding
              ON binding.teammate_id = target.id AND binding.runtime_profile_id = runtime.id
            WHERE runtime.id = target.current_runtime_profile_id
              AND runtime.execution_protocol = new.execution_protocol
              AND binding.execution_protocol = new.execution_protocol
          )))
  )
  OR (new.parent_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM g3_execution_tasks AS parent
    WHERE parent.id = new.parent_task_id
      AND parent.mission_id = new.mission_id AND parent.run_id = new.run_id
      AND parent.collaboration_request_id IS new.collaboration_request_id
      AND parent.target_teammate_id = new.target_teammate_id
      AND parent.execution_protocol = new.execution_protocol
      AND parent.continuation_round + 1 = new.continuation_round
      AND (parent.retry_no = new.retry_no OR parent.retry_no + 1 = new.retry_no)
  ))
  OR (new.execution_protocol = 'GENERATION' AND (
       json_type(new.task_json, '$.generationRequirements') IS NOT 'object'
    OR json_extract(new.task_json, '$.generationRequirements.capability') IS NOT new.required_capability
    OR json_type(new.task_json, '$.generationRequirements.requiredFeatures') IS NOT 'array'
    OR json_type(new.task_json, '$.generationRequirements.parameters') IS NOT 'object'
    OR json_type(new.task_json, '$.generationRequirements.expectedOutput') IS NOT 'object'
    OR json_type(new.task_json, '$.generationRequirements.outputDestination') IS NOT 'object'
  ))
  OR (new.execution_protocol != 'GENERATION' AND json_type(new.task_json, '$.generationRequirements') IS 'object')
BEGIN
  SELECT RAISE(ABORT, 'ExecutionTask identity, approval, provenance, or protocol is invalid');
END;

CREATE TRIGGER g3_execution_tasks_immutable
BEFORE UPDATE ON g3_execution_tasks
BEGIN
  SELECT RAISE(ABORT, 'G3 ExecutionTask snapshots are immutable');
END;
CREATE TRIGGER g3_execution_tasks_no_delete
BEFORE DELETE ON g3_execution_tasks
BEGIN
  SELECT RAISE(ABORT, 'G3 ExecutionTask history is retained');
END;

CREATE TABLE g3_execution_attempts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL REFERENCES g3_execution_tasks(id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  runtime_profile_id TEXT REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED','RUNNING','WAITING_INPUT','WAITING_CAPABILITY','WAITING_USER','COMPLETED','FAILED','UNKNOWN'
  )),
  generation_job_id TEXT UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
  external_work_request_id TEXT REFERENCES external_work_requests(id) ON DELETE RESTRICT,
  error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 64),
  UNIQUE (task_id, attempt_no),
  CHECK (state != 'PREPARED' OR error_code IS NULL)
);

CREATE INDEX g3_execution_attempts_state_created ON g3_execution_attempts(state, updated_at, id);
CREATE INDEX g3_execution_attempts_task_created ON g3_execution_attempts(task_id, attempt_no);

CREATE TRIGGER g3_execution_attempts_validate_insert
BEFORE INSERT ON g3_execution_attempts
WHEN new.state != 'PREPARED'
  OR new.generation_job_id IS NOT NULL
  OR new.external_work_request_id IS NOT NULL
  OR new.error_code IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM g3_execution_tasks AS task
    WHERE task.id = new.task_id
      AND (new.runtime_profile_id IS NULL OR EXISTS (
        SELECT 1 FROM teammates AS teammate
        JOIN runtime_profiles AS runtime ON runtime.id = new.runtime_profile_id
        JOIN teammate_model_bindings AS binding
          ON binding.teammate_id = teammate.id AND binding.runtime_profile_id = runtime.id
        WHERE teammate.id = task.target_teammate_id
          AND teammate.executor_kind = 'MODEL_RUNTIME'
          AND teammate.current_runtime_profile_id = runtime.id
          AND runtime.execution_protocol = task.execution_protocol
          AND binding.execution_protocol = task.execution_protocol
      ))
      AND (task.execution_protocol != 'USER_BRIDGE' OR new.runtime_profile_id IS NULL)
      AND (SELECT count(*) FROM g3_execution_attempts AS prior
           JOIN g3_execution_tasks AS prior_task ON prior_task.id = prior.task_id
           WHERE prior_task.logical_key = task.logical_key) < 3
  )
BEGIN
  SELECT RAISE(ABORT, 'ExecutionAttempt must start prepared with matching sealed Runtime provenance');
END;

CREATE TRIGGER g3_execution_attempts_identity_immutable
BEFORE UPDATE ON g3_execution_attempts
WHEN new.id IS NOT old.id OR new.task_id IS NOT old.task_id
  OR new.attempt_no IS NOT old.attempt_no OR new.created_at IS NOT old.created_at
  OR (old.runtime_profile_id IS NOT NULL AND new.runtime_profile_id IS NOT old.runtime_profile_id)
  OR (old.runtime_profile_id IS NULL AND new.runtime_profile_id IS NOT NULL AND old.state != 'PREPARED')
  OR (old.generation_job_id IS NOT new.generation_job_id AND NOT (
       old.generation_job_id IS NULL AND new.generation_job_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM generation_jobs AS job
         JOIN generation_tasks AS generation_task ON generation_task.id = job.generation_task_id
         JOIN g3_execution_tasks AS task ON task.id = old.task_id
         WHERE job.id = new.generation_job_id
           AND json_extract(generation_task.task_json, '$.executionAttemptId') = old.id
           AND json_extract(generation_task.task_json, '$.missionId') = task.mission_id
           AND json_extract(generation_task.task_json, '$.runId') = task.run_id
           AND json_extract(generation_task.task_json, '$.collaborationRequestId') IS task.collaboration_request_id
           AND generation_task.target_teammate_id = task.target_teammate_id
           AND job.teammate_id = task.target_teammate_id
           AND job.runtime_profile_id = old.runtime_profile_id
       )
  ))
  OR (old.external_work_request_id IS NOT new.external_work_request_id AND NOT (
       old.external_work_request_id IS NULL AND new.external_work_request_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM external_work_requests AS request
         JOIN g3_execution_tasks AS task ON task.id = old.task_id
         WHERE request.id = new.external_work_request_id
           AND request.mission_id = task.mission_id AND request.run_id = task.run_id
           AND ((task.execution_protocol = 'USER_BRIDGE'
                 AND request.assignee_teammate_id = task.target_teammate_id)
             OR (task.execution_protocol IN ('LANGUAGE','GENERATION')
                 AND old.state IN ('WAITING_USER','COMPLETED')))
       )
  ))
BEGIN
  SELECT RAISE(ABORT, 'ExecutionAttempt identity and external bindings are immutable');
END;

CREATE TRIGGER g3_execution_attempts_state_guard
BEFORE UPDATE ON g3_execution_attempts
WHEN (old.state IS NOT new.state AND (
       old.state IN ('COMPLETED','FAILED','UNKNOWN')
    OR NOT (
       (old.state = 'PREPARED' AND new.state IN ('RUNNING','WAITING_INPUT','WAITING_CAPABILITY','WAITING_USER','FAILED','UNKNOWN'))
    OR (old.state = 'RUNNING' AND new.state IN ('WAITING_INPUT','WAITING_CAPABILITY','WAITING_USER','COMPLETED','FAILED','UNKNOWN'))
    OR (old.state = 'WAITING_INPUT' AND new.state IN ('RUNNING','WAITING_USER','FAILED','UNKNOWN'))
    OR (old.state = 'WAITING_CAPABILITY' AND new.state IN ('RUNNING','WAITING_USER','FAILED','UNKNOWN'))
    OR (old.state = 'WAITING_USER' AND new.state IN ('RUNNING','FAILED','UNKNOWN'))
    )
  ))
  OR (new.state = 'RUNNING' AND NOT EXISTS (
    SELECT 1 FROM g3_execution_tasks AS task
    WHERE task.id = new.task_id
      AND ((task.execution_protocol = 'USER_BRIDGE' AND new.runtime_profile_id IS NULL)
        OR (task.execution_protocol IN ('LANGUAGE','GENERATION')
          AND new.runtime_profile_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM teammates AS teammate
            JOIN runtime_profiles AS runtime ON runtime.id = new.runtime_profile_id
            JOIN teammate_model_bindings AS binding
              ON binding.teammate_id = teammate.id AND binding.runtime_profile_id = runtime.id
            WHERE teammate.id = task.target_teammate_id
              AND teammate.current_runtime_profile_id = runtime.id
              AND runtime.execution_protocol = task.execution_protocol
              AND binding.execution_protocol = task.execution_protocol
          )))
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invalid ExecutionAttempt state transition or runtime identity');
END;

CREATE TRIGGER g3_execution_attempts_no_delete
BEFORE DELETE ON g3_execution_attempts
BEGIN
  SELECT RAISE(ABORT, 'G3 ExecutionAttempt history is retained');
END;

CREATE TABLE g3_artifact_refs (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL CHECK (length(trim(artifact_id)) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 80),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 160),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  source_type TEXT CHECK (source_type IS NULL OR source_type IN ('GENERATION','EXTERNAL_WORK','APPROVED_IMPORT')),
  source_id TEXT CHECK (source_id IS NULL OR length(trim(source_id)) BETWEEN 1 AND 256),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(provenance_json) AND json_type(provenance_json) = 'object'
      AND length(CAST(provenance_json AS BLOB)) <= 8192
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  PRIMARY KEY (mission_id, run_id, artifact_id),
  CHECK ((source_type IS NULL AND source_id IS NULL) OR (source_type IS NOT NULL AND source_id IS NOT NULL))
);

CREATE INDEX g3_artifact_refs_run_created ON g3_artifact_refs(mission_id, run_id, created_at, artifact_id);
CREATE INDEX g3_artifact_refs_hash ON g3_artifact_refs(content_hash);

CREATE TRIGGER g3_artifact_refs_validate_insert
BEFORE INSERT ON g3_artifact_refs
WHEN NOT EXISTS (SELECT 1 FROM mission_runs WHERE id = new.run_id AND mission_id = new.mission_id)
  OR new.source_type IS NULL
  OR (new.source_type = 'GENERATION' AND NOT EXISTS (
    SELECT 1 FROM generation_artifacts AS artifact
    JOIN generation_jobs AS job ON job.id = artifact.job_id
    JOIN generation_tasks AS task ON task.id = job.generation_task_id
    WHERE artifact.id = new.source_id AND artifact.id = new.artifact_id
      AND artifact.kind = new.kind AND artifact.mime_type = new.mime_type
      AND artifact.content_hash = new.content_hash AND artifact.size_bytes = new.size_bytes
      AND job.state = 'COMPLETED'
      AND json_extract(task.task_json, '$.missionId') = new.mission_id
      AND json_extract(task.task_json, '$.runId') = new.run_id
  ))
  OR (new.source_type = 'APPROVED_IMPORT' AND NOT EXISTS (
    SELECT 1 FROM workflow_artifacts AS artifact
    JOIN workflow_artifact_bindings AS binding ON binding.artifact_id = artifact.id AND binding.role = 'INPUT'
    JOIN workflow_step_runs AS step ON step.id = binding.step_run_id AND step.workflow_run_id = artifact.workflow_run_id
    JOIN workflow_validation_receipts AS receipt ON receipt.artifact_id = artifact.id AND receipt.valid = 1 AND receipt.content_hash = artifact.content_hash
    JOIN generation_artifacts AS media ON media.id = new.artifact_id
    JOIN generation_jobs AS job ON job.id = media.job_id AND job.state = 'COMPLETED'
    JOIN generation_tasks AS task ON task.id = job.generation_task_id
    WHERE artifact.id = new.source_id AND step.mission_id = new.mission_id
      AND json_extract(task.task_json,'$.workflowRunId') = artifact.workflow_run_id
      AND json_extract(artifact.content,'$.type') = 'GENERATION_ARTIFACT_REF'
      AND json_extract(artifact.content,'$.artifact.id') = new.artifact_id
      AND json_extract(artifact.content,'$.artifact.contentHash') = new.content_hash
      AND media.content_hash = new.content_hash AND media.kind = new.kind
      AND media.mime_type = new.mime_type AND media.size_bytes = new.size_bytes
  ))
  OR (new.source_type = 'EXTERNAL_WORK' AND NOT EXISTS (
    SELECT 1 FROM external_work_artifacts AS artifact
    JOIN external_work_requests AS request ON request.id = artifact.external_work_request_id
    WHERE artifact.id = new.source_id AND artifact.id = new.artifact_id
      AND request.state = 'ACCEPTED' AND request.mission_id = new.mission_id AND request.run_id = new.run_id
      AND (artifact.mime_type IS NULL OR artifact.mime_type = new.mime_type)
      AND artifact.size_bytes = new.size_bytes
      AND json_extract(artifact.metadata_json, '$.contentHash') = new.content_hash
      AND ((artifact.extension = '.png' AND new.kind = 'IMAGE' AND new.mime_type = 'image/png')
        OR (artifact.extension = '.wav' AND new.kind = 'AUDIO' AND new.mime_type = 'audio/wav')
        OR (artifact.extension = '.mp4' AND new.kind = 'VIDEO' AND new.mime_type = 'video/mp4'))
  ))
  OR (new.source_type IS NOT 'APPROVED_IMPORT' AND EXISTS (
    SELECT 1 FROM g3_artifact_refs AS prior
    WHERE prior.artifact_id = new.artifact_id
      AND (prior.mission_id != new.mission_id OR prior.run_id != new.run_id)
  ))
BEGIN
  SELECT RAISE(ABORT, 'ArtifactRef must be a persisted same-Run Artifact or an explicit approved import');
END;

CREATE TRIGGER g3_artifact_refs_immutable
BEFORE UPDATE ON g3_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'G3 ArtifactRefs are immutable');
END;
CREATE TRIGGER g3_artifact_refs_no_delete
BEFORE DELETE ON g3_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'G3 ArtifactRefs are retained');
END;

CREATE TABLE g3_participant_outcomes (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL REFERENCES g3_execution_tasks(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES g3_execution_attempts(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  collaboration_request_id TEXT REFERENCES collaboration_requests(id) ON DELETE RESTRICT,
  participant_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  execution_protocol TEXT NOT NULL CHECK (execution_protocol IN ('LANGUAGE','GENERATION','USER_BRIDGE')),
  kind TEXT NOT NULL CHECK (kind IN ('RESULT','NEEDS_INPUT','NEEDS_CAPABILITY','FAILED_RETRYABLE','FAILED_TERMINAL')),
  outcome_json TEXT NOT NULL CHECK (
    json_valid(outcome_json) AND json_type(outcome_json) = 'object'
      AND length(CAST(outcome_json AS BLOB)) <= 32768
      AND json_extract(outcome_json, '$.kind') = kind
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  consumed_at TEXT CHECK (consumed_at IS NULL OR length(trim(consumed_at)) BETWEEN 1 AND 64),
  UNIQUE (id, attempt_id),
  CHECK (
    (kind = 'RESULT' AND json_type(outcome_json, '$.artifactRefs') = 'array'
      AND json_array_length(outcome_json, '$.artifactRefs') <= 32
      AND (json_type(outcome_json, '$.publicResult') IS NULL OR
           (json_type(outcome_json, '$.publicResult') = 'text' AND length(json_extract(outcome_json, '$.publicResult')) <= 4000)))
    OR (kind = 'NEEDS_INPUT' AND json_type(outcome_json, '$.requirements') = 'array'
      AND json_array_length(outcome_json, '$.requirements') <= 16
      AND json_type(outcome_json, '$.reason') = 'text' AND length(json_extract(outcome_json, '$.reason')) <= 2000)
    OR (kind = 'NEEDS_CAPABILITY' AND json_type(outcome_json, '$.capability') = 'text'
      AND json_type(outcome_json, '$.reason') = 'text' AND length(json_extract(outcome_json, '$.reason')) <= 2000
      AND (json_type(outcome_json, '$.requiredFeatures') IS NULL OR
           (json_type(outcome_json, '$.requiredFeatures') = 'array' AND json_array_length(outcome_json, '$.requiredFeatures') <= 32))
      AND (json_type(outcome_json, '$.requestedInputs') IS NULL OR
           (json_type(outcome_json, '$.requestedInputs') = 'array' AND json_array_length(outcome_json, '$.requestedInputs') <= 16)))
    OR (kind IN ('FAILED_RETRYABLE','FAILED_TERMINAL')
      AND json_type(outcome_json, '$.errorCode') = 'text' AND length(json_extract(outcome_json, '$.errorCode')) BETWEEN 1 AND 80
      AND json_extract(outcome_json, '$.errorCode') NOT GLOB '*[^A-Z0-9_]*'
      AND json_type(outcome_json, '$.reason') = 'text' AND length(json_extract(outcome_json, '$.reason')) <= 2000)
  )
);

CREATE INDEX g3_participant_outcomes_run_created ON g3_participant_outcomes(mission_id, run_id, created_at, id);

CREATE TRIGGER g3_participant_outcomes_validate_insert
BEFORE INSERT ON g3_participant_outcomes
WHEN EXISTS (
  SELECT 1 FROM json_each(new.outcome_json) AS field
  WHERE field.key NOT IN ('kind','publicResult','artifactRefs','requirements','capability','requiredFeatures','requestedInputs','errorCode','reason')
)
  OR (new.kind = 'RESULT' AND EXISTS (
    SELECT 1 FROM json_each(new.outcome_json) AS field
    WHERE field.key NOT IN ('kind','publicResult','artifactRefs')
  ))
  OR (new.kind = 'NEEDS_INPUT' AND EXISTS (
    SELECT 1 FROM json_each(new.outcome_json) AS field
    WHERE field.key NOT IN ('kind','requirements','reason')
  ))
  OR (new.kind = 'NEEDS_CAPABILITY' AND EXISTS (
    SELECT 1 FROM json_each(new.outcome_json) AS field
    WHERE field.key NOT IN ('kind','capability','requiredFeatures','requestedInputs','reason')
  ))
  OR (new.kind IN ('FAILED_RETRYABLE','FAILED_TERMINAL') AND EXISTS (
    SELECT 1 FROM json_each(new.outcome_json) AS field
    WHERE field.key NOT IN ('kind','errorCode','reason')
  ))
  OR EXISTS (
    SELECT 1 FROM json_each(new.outcome_json, '$.requirements') AS requirement
    WHERE json_type(requirement.value) IS NOT 'object'
      OR EXISTS (
        SELECT 1 FROM json_each(requirement.value) AS field
        WHERE field.key NOT IN ('role','artifactKinds','mimeTypes','required')
      )
      OR json_type(requirement.value, '$.role') IS NOT 'text'
      OR length(json_extract(requirement.value, '$.role')) NOT BETWEEN 1 AND 80
      OR (json_type(requirement.value, '$.required') IS NOT 'true' AND json_type(requirement.value, '$.required') IS NOT 'false')
      OR (json_type(requirement.value, '$.artifactKinds') IS NOT NULL AND
          (json_type(requirement.value, '$.artifactKinds') IS NOT 'array' OR json_array_length(requirement.value, '$.artifactKinds') > 32))
      OR (json_type(requirement.value, '$.mimeTypes') IS NOT NULL AND
          (json_type(requirement.value, '$.mimeTypes') IS NOT 'array' OR json_array_length(requirement.value, '$.mimeTypes') > 32))
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.outcome_json, '$.artifactRefs') AS artifact
    WHERE json_type(artifact.value) IS NOT 'object'
      OR EXISTS (
        SELECT 1 FROM json_each(artifact.value) AS field
        WHERE field.key NOT IN ('id','kind','mimeType','contentHash','sizeBytes')
      )
      OR json_type(artifact.value, '$.id') IS NOT 'text'
      OR json_type(artifact.value, '$.kind') IS NOT 'text'
      OR json_type(artifact.value, '$.mimeType') IS NOT 'text'
      OR json_type(artifact.value, '$.contentHash') IS NOT 'text'
      OR json_type(artifact.value, '$.sizeBytes') IS NOT 'integer'
  )
  OR NOT EXISTS (
    SELECT 1 FROM g3_execution_attempts AS attempt
    JOIN g3_execution_tasks AS task ON task.id = attempt.task_id
    WHERE attempt.id = new.attempt_id AND attempt.task_id = new.task_id
      AND task.mission_id = new.mission_id AND task.run_id = new.run_id
      AND task.collaboration_request_id IS new.collaboration_request_id
      AND task.target_teammate_id = new.participant_teammate_id
      AND task.execution_protocol = new.execution_protocol
      AND ((new.kind = 'RESULT' AND attempt.state = 'COMPLETED')
        OR (new.kind = 'NEEDS_INPUT' AND attempt.state = 'WAITING_INPUT')
        OR (new.kind = 'NEEDS_CAPABILITY' AND attempt.state = 'WAITING_CAPABILITY')
        OR (new.kind IN ('FAILED_RETRYABLE','FAILED_TERMINAL') AND attempt.state = 'FAILED'))
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.outcome_json, '$.artifactRefs') AS output
    WHERE NOT EXISTS (
      SELECT 1 FROM g3_artifact_refs AS artifact
      WHERE artifact.mission_id = new.mission_id AND artifact.run_id = new.run_id
        AND artifact.artifact_id = json_extract(output.value, '$.id')
        AND artifact.kind = json_extract(output.value, '$.kind')
        AND artifact.mime_type = json_extract(output.value, '$.mimeType')
        AND artifact.content_hash = lower(json_extract(output.value, '$.contentHash'))
        AND artifact.size_bytes = json_extract(output.value, '$.sizeBytes')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ParticipantOutcome must be strict and match its task, attempt, protocol, and Run');
END;

CREATE TRIGGER g3_participant_outcomes_identity_immutable
BEFORE UPDATE ON g3_participant_outcomes
WHEN new.id IS NOT old.id OR new.task_id IS NOT old.task_id OR new.attempt_id IS NOT old.attempt_id
  OR new.mission_id IS NOT old.mission_id OR new.run_id IS NOT old.run_id
  OR new.collaboration_request_id IS NOT old.collaboration_request_id
  OR new.participant_teammate_id IS NOT old.participant_teammate_id
  OR new.execution_protocol IS NOT old.execution_protocol OR new.kind IS NOT old.kind
  OR new.outcome_json IS NOT old.outcome_json OR new.created_at IS NOT old.created_at
  OR old.consumed_at IS NOT NULL OR new.consumed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ParticipantOutcome is append-only and may be consumed once');
END;
CREATE TRIGGER g3_participant_outcomes_no_delete
BEFORE DELETE ON g3_participant_outcomes
BEGIN
  SELECT RAISE(ABORT, 'ParticipantOutcome history is retained');
END;

CREATE TABLE g3_continuations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  outcome_id TEXT NOT NULL UNIQUE REFERENCES g3_participant_outcomes(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES g3_execution_tasks(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES g3_execution_attempts(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  collaboration_request_id TEXT REFERENCES collaboration_requests(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('RESUME','WAIT_FOR_USER','REQUEST_CAPABILITY','REQUEST_INPUT','RETRY','REVIEW','RESULT','FAIL')),
  decision_json TEXT NOT NULL CHECK (
    json_valid(decision_json) AND json_type(decision_json) = 'object'
      AND length(CAST(decision_json AS BLOB)) <= 12288
      AND json_extract(decision_json, '$.action') = action
  ),
  continuation_round INTEGER NOT NULL CHECK (continuation_round BETWEEN 1 AND 3),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 64),
  consumed_at TEXT CHECK (consumed_at IS NULL OR length(trim(consumed_at)) BETWEEN 1 AND 64)
);

CREATE INDEX g3_continuations_pending ON g3_continuations(consumed_at, created_at, id);

CREATE TRIGGER g3_continuations_validate_insert
BEFORE INSERT ON g3_continuations
WHEN EXISTS (
    SELECT 1 FROM json_each(new.decision_json) AS field
    WHERE field.key NOT IN ('action','reason','nextTaskId','data')
  )
  OR (json_type(new.decision_json, '$.reason') IS NOT NULL AND
      (json_type(new.decision_json, '$.reason') != 'text' OR length(json_extract(new.decision_json, '$.reason')) > 2000))
  OR (json_type(new.decision_json, '$.nextTaskId') IS NOT NULL AND
      (json_type(new.decision_json, '$.nextTaskId') NOT IN ('text','null') OR length(COALESCE(json_extract(new.decision_json, '$.nextTaskId'), '')) > 256))
  OR (json_type(new.decision_json, '$.data') IS NOT NULL AND json_type(new.decision_json, '$.data') != 'object')
  OR NOT EXISTS (
    SELECT 1 FROM g3_participant_outcomes AS outcome
    JOIN g3_execution_tasks AS task ON task.id = outcome.task_id
    JOIN g3_execution_attempts AS attempt ON attempt.id = outcome.attempt_id
    WHERE outcome.id = new.outcome_id
      AND outcome.task_id = new.task_id AND outcome.attempt_id = new.attempt_id
      AND outcome.mission_id = new.mission_id AND outcome.run_id = new.run_id
      AND outcome.collaboration_request_id IS new.collaboration_request_id
      AND task.continuation_round + 1 = new.continuation_round
      AND attempt.id = outcome.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Continuation decision intent must bind the existing outcome and bounded Run round');
END;

CREATE TRIGGER g3_continuations_identity_immutable
BEFORE UPDATE ON g3_continuations
WHEN new.id IS NOT old.id OR new.outcome_id IS NOT old.outcome_id OR new.task_id IS NOT old.task_id
  OR new.attempt_id IS NOT old.attempt_id OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id OR new.collaboration_request_id IS NOT old.collaboration_request_id
  OR new.action IS NOT old.action OR new.decision_json IS NOT old.decision_json
  OR new.continuation_round IS NOT old.continuation_round OR new.created_at IS NOT old.created_at
  OR old.consumed_at IS NOT NULL OR new.consumed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Continuation decision is append-only and may be consumed once');
END;
CREATE TRIGGER g3_continuations_no_delete
BEFORE DELETE ON g3_continuations
BEGIN
  SELECT RAISE(ABORT, 'Continuation history is retained');
END;

-- The GenerationTask/Job identity remains owned by G1/G2; G3 adds one atomic
-- attempt binding when a generation execution originated in this bridge.
CREATE TRIGGER g3_generation_jobs_validate_attempt
BEFORE INSERT ON generation_jobs
WHEN (
     json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.executionAttemptId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.collaborationRequestId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.workflowRunId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.workflowStepRunId') IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM generation_tasks AS generation_task
    JOIN g3_execution_attempts AS attempt
      ON attempt.id = json_extract(generation_task.task_json, '$.executionAttemptId')
    JOIN g3_execution_tasks AS task ON task.id = attempt.task_id
    JOIN teammates AS teammate ON teammate.id = task.target_teammate_id
    JOIN runtime_profiles AS runtime ON runtime.id = new.runtime_profile_id
    JOIN teammate_model_bindings AS binding
      ON binding.teammate_id = teammate.id AND binding.runtime_profile_id = runtime.id
    WHERE generation_task.id = new.generation_task_id
      AND generation_task.target_teammate_id = task.target_teammate_id
      AND json_extract(generation_task.task_json, '$.missionId') = task.mission_id
      AND json_extract(generation_task.task_json, '$.runId') = task.run_id
      AND json_extract(generation_task.task_json, '$.collaborationRequestId') IS task.collaboration_request_id
      AND json_extract(generation_task.task_json, '$.executionAttemptId') = attempt.id
      AND json_extract(generation_task.task_json, '$.workflowRunId') IS task.workflow_run_id
      AND json_extract(generation_task.task_json, '$.workflowStepRunId') IS task.workflow_step_run_id
      AND new.teammate_id = task.target_teammate_id
      AND attempt.runtime_profile_id = new.runtime_profile_id
      AND attempt.generation_job_id IS NULL
      AND task.execution_protocol = 'GENERATION'
      AND runtime.execution_protocol = 'GENERATION'
      AND binding.execution_protocol = 'GENERATION'
      AND teammate.current_runtime_profile_id = runtime.id
      AND (task.collaboration_request_id IS NULL OR EXISTS (
        SELECT 1 FROM collaboration_requests AS request
        WHERE request.id = task.collaboration_request_id AND request.state = 'APPROVED'
          AND request.mission_id = task.mission_id AND request.run_id = task.run_id
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob must match one approved G3 GENERATION attempt and its provenance');
END;

CREATE TRIGGER g3_generation_jobs_bind_attempt
AFTER INSERT ON generation_jobs
WHEN (
     json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.executionAttemptId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.collaborationRequestId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.workflowRunId') IS NOT NULL
  OR json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.workflowStepRunId') IS NOT NULL
  )
BEGIN
  UPDATE g3_execution_attempts
  SET generation_job_id = new.id
  WHERE id = json_extract((SELECT task_json FROM generation_tasks WHERE id = new.generation_task_id), '$.executionAttemptId')
    AND generation_job_id IS NULL;
END;

-- A Party Coordinator must remain a language-capable MODEL_RUNTIME. Existing
-- records are retained; these guards apply to new and changed coordinator bindings.
CREATE TRIGGER g3_parties_language_coordinator_insert
BEFORE INSERT ON parties
WHEN NOT EXISTS (
  SELECT 1 FROM teammates AS teammate
  JOIN runtime_profiles AS runtime ON runtime.id = teammate.current_runtime_profile_id
  LEFT JOIN teammate_model_bindings AS binding
    ON binding.teammate_id = teammate.id AND binding.runtime_profile_id = runtime.id
  WHERE teammate.id = new.coordinator_teammate_id
    AND teammate.executor_kind = 'MODEL_RUNTIME' AND teammate.system_kind IS NULL
    AND teammate.status = 'ACTIVE'
    AND runtime.execution_protocol = 'LANGUAGE' AND (binding.execution_protocol IS NULL OR binding.execution_protocol = 'LANGUAGE')
)
BEGIN
  SELECT RAISE(ABORT, 'Party Coordinator must use an active LANGUAGE Runtime');
END;

CREATE TRIGGER g3_parties_language_coordinator_update
BEFORE UPDATE OF coordinator_teammate_id ON parties
WHEN new.coordinator_teammate_id IS NOT old.coordinator_teammate_id
 AND NOT EXISTS (
  SELECT 1 FROM teammates AS teammate
  JOIN runtime_profiles AS runtime ON runtime.id = teammate.current_runtime_profile_id
  LEFT JOIN teammate_model_bindings AS binding
    ON binding.teammate_id = teammate.id AND binding.runtime_profile_id = runtime.id
  WHERE teammate.id = new.coordinator_teammate_id
    AND teammate.executor_kind = 'MODEL_RUNTIME' AND teammate.system_kind IS NULL
    AND teammate.status = 'ACTIVE'
    AND runtime.execution_protocol = 'LANGUAGE' AND (binding.execution_protocol IS NULL OR binding.execution_protocol = 'LANGUAGE')
)
BEGIN
  SELECT RAISE(ABORT, 'Party Coordinator must use an active LANGUAGE Runtime');
END;
-- G3 Workflow Generation provenance guard. Merge this trigger into migration 0030.
-- The existing W1 trigger still requires the ordinary completed MissionRun JSON contract;
-- this additional guard prevents a plain Mission JSON response from impersonating a media ref.
CREATE TRIGGER workflow_generation_artifact_ref_validate_insert
BEFORE INSERT ON workflow_artifacts
WHEN (
    (json_valid(new.content)
      AND json_extract(new.content, '$.type') = 'GENERATION_ARTIFACT_REF')
    OR EXISTS (
      SELECT 1
      FROM workflow_step_runs AS candidate
      JOIN workflow_runs AS candidate_run ON candidate_run.id = candidate.workflow_run_id
      JOIN workflow_versions AS candidate_version ON candidate_version.definition_id = candidate_run.definition_id
        AND candidate_version.version = candidate_run.definition_version
      JOIN json_each(candidate_version.version_json, '$.steps') AS frozen
        ON json_extract(frozen.value, '$.id') = candidate.step_id
      WHERE candidate.id = new.producer_step_run_id
        AND json_extract(frozen.value, '$.routing.requiredExecutionProtocol') = 'GENERATION'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_step_runs AS sr
    JOIN workflow_runs AS wr ON wr.id = sr.workflow_run_id
    JOIN workflow_steps AS ws ON ws.definition_id = wr.definition_id
      AND ws.version = wr.definition_version AND ws.id = sr.step_id
    JOIN workflow_versions AS wv ON wv.definition_id = wr.definition_id
      AND wv.version = wr.definition_version
    JOIN mission_runs AS mr ON mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
    JOIN missions AS m ON m.id = mr.mission_id
    JOIN generation_jobs AS job ON job.id = json_extract(new.metadata_json, '$.generationJobId')
    JOIN generation_tasks AS task ON task.id = job.generation_task_id
    JOIN mission_events AS event ON event.id = json_extract(new.metadata_json, '$.evidenceEventId')
    WHERE sr.id = new.producer_step_run_id
      AND sr.workflow_run_id = new.workflow_run_id
      AND sr.state = 'RUNNING'
      AND sr.mission_id = new.mission_id
      AND sr.mission_run_id = new.mission_run_id
      AND mr.status = 'COMPLETED'
      AND m.state = 'COMPLETED'
      AND m.coordinator_teammate_id = new.actor_id
      AND new.source = 'MISSION'
      AND new.kind = 'JSON'
      AND new.source_id = mr.id
      AND mr.result_text IS new.content
      AND json_extract(new.content, '$.type') = 'GENERATION_ARTIFACT_REF'
      AND json_extract(new.metadata_json, '$.generationJobId') = job.id
      AND json_extract(new.metadata_json, '$.generationTaskId') = task.id
      AND json_extract(new.metadata_json, '$.workflowStepRunId') = sr.id
      AND json_extract(task.task_json, '$.missionId') = new.mission_id
      AND json_extract(task.task_json, '$.runId') = new.mission_run_id
      AND json_extract(task.task_json, '$.workflowRunId') = new.workflow_run_id
      AND json_extract(task.task_json, '$.workflowStepRunId') = sr.id
      AND json_extract(task.task_json, '$.requester.actorType') = 'WORKFLOW'
      AND json_extract(task.task_json, '$.targetTeammateId') = new.actor_id
      AND job.teammate_id = new.actor_id
      AND job.generation_task_id = task.id
      AND job.state = 'COMPLETED'
      AND json_valid(job.output_artifact_ids_json)
      AND json_type(job.output_artifact_ids_json) = 'array'
      AND json_array_length(job.output_artifact_ids_json) > 0
      AND json_array_length(job.output_artifact_ids_json) = 1
      AND json_type(new.content, '$.artifact') = 'object'
      AND json_extract(new.metadata_json, '$.generationArtifactId') = json_extract(new.content, '$.artifact.id')
      AND json_extract(new.metadata_json, '$.contentHash') = json_extract(new.content, '$.artifact.contentHash')
      AND json_extract(new.metadata_json, '$.mimeType') = json_extract(new.content, '$.artifact.mimeType')
      AND json_extract(new.metadata_json, '$.sizeBytes') = json_extract(new.content, '$.artifact.sizeBytes')
      AND json_extract(new.metadata_json, '$.kind') = json_extract(new.content, '$.artifact.kind')
      AND event.mission_id = new.mission_id
      AND event.run_id = new.mission_run_id
      AND event.actor_type = 'TEAMMATE'
      AND event.actor_id = new.actor_id
      AND event.event_type = 'g3.workflow_generation_completed'
      AND json_extract(event.payload_json, '$.generationJobId') = job.id
      AND json_extract(event.payload_json, '$.workflowStepRunId') = sr.id
      AND json_type(event.payload_json, '$.artifactIds') = 'array'
      AND json_array_length(event.payload_json, '$.artifactIds') = 1
      AND EXISTS (
        SELECT 1
        FROM json_each(wv.version_json, '$.steps') AS frozen
        WHERE json_extract(frozen.value, '$.id') = sr.step_id
          AND json_extract(frozen.value, '$.type') = 'TASK'
          AND json_extract(frozen.value, '$.routing.requiredExecutionProtocol') = 'GENERATION'
          AND json_type(frozen.value, '$.executionRequirements.generation') = 'object'
          AND json_extract(frozen.value, '$.executionRequirements.generation.capability') = json_extract(task.task_json, '$.capability')
          AND json_extract(frozen.value, '$.executionRequirements.generation.expectedOutput.artifactKind') = json_extract(task.task_json, '$.expectedOutput.artifactKind')
          AND coalesce(
            json_extract(frozen.value, '$.executionRequirements.generation.outputDestination.scope'),
            'APP_ARTIFACT_STORE'
          ) = json_extract(task.task_json, '$.outputDestination.scope')
          AND coalesce(
            json_extract(frozen.value, '$.executionRequirements.generation.outputDestination.logicalPathHint'),
            ''
          ) = coalesce(json_extract(task.task_json, '$.outputDestination.logicalPathHint'), '')
          AND json(json_extract(frozen.value, '$.executionRequirements.generation.requiredFeatures'))
            = json(json_extract(task.task_json, '$.requiredFeatures'))
          AND json(json_extract(frozen.value, '$.executionRequirements.generation.parameters'))
            = json(json_extract(task.task_json, '$.parameters'))
          AND json(json_extract(frozen.value, '$.executionRequirements.generation.expectedOutput.mimeTypes'))
            = json(json_extract(task.task_json, '$.expectedOutput.mimeTypes'))
      )
      AND EXISTS (
        SELECT 1 FROM json_each(ws.outputs_json) AS spec
        WHERE json_extract(spec.value, '$.key') = json_extract(new.metadata_json, '$.outputKey')
          AND json_extract(spec.value, '$.kind') = 'JSON'
          AND json_extract(spec.value, '$.required') = 1
          AND json_extract(spec.value, '$.validator.type') = 'JSON'
          AND EXISTS (
            SELECT 1 FROM json_each(spec.value, '$.validator.requiredKeys') AS required_key
            WHERE required_key.value = 'type'
          )
          AND EXISTS (
            SELECT 1 FROM json_each(spec.value, '$.validator.requiredKeys') AS required_key
            WHERE required_key.value = 'artifact'
          )
      )
      AND json_array_length(ws.outputs_json) = 1
      AND (
        json_extract(task.task_json, '$.outputDestination.scope') = 'APP_ARTIFACT_STORE'
        OR (
          json_extract(task.task_json, '$.outputDestination.scope') = 'MISSION_WORKSPACE'
          AND EXISTS (
            SELECT 1 FROM mission_events AS destination
            WHERE destination.mission_id = new.mission_id
              AND destination.run_id = new.mission_run_id
              AND destination.event_type = 'generation.output_destination_bound'
              AND json_extract(destination.payload_json, '$.teammateId') = new.actor_id
              AND json_extract(destination.payload_json, '$.logicalPathHint') = json_extract(task.task_json, '$.outputDestination.logicalPathHint')
          )
        )
      )
      AND EXISTS (
        SELECT 1
        FROM generation_artifacts AS artifact
        WHERE artifact.id = json_extract(new.content, '$.artifact.id')
          AND artifact.job_id = job.id
          AND artifact.id = json_extract(job.output_artifact_ids_json, '$[0]')
          AND artifact.id = json_extract(event.payload_json, '$.artifactIds[0]')
          AND artifact.kind = json_extract(new.content, '$.artifact.kind')
          AND artifact.mime_type = json_extract(new.content, '$.artifact.mimeType')
          AND artifact.size_bytes = json_extract(new.content, '$.artifact.sizeBytes')
          AND artifact.content_hash = json_extract(new.content, '$.artifact.contentHash')
          AND artifact.content_hash = json_extract(new.metadata_json, '$.contentHash')
          AND artifact.mime_type = json_extract(new.metadata_json, '$.mimeType')
          AND artifact.size_bytes = json_extract(new.metadata_json, '$.sizeBytes')
          AND artifact.kind = json_extract(new.metadata_json, '$.kind')
          AND artifact.storage_scope = json_extract(task.task_json, '$.outputDestination.scope')
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.content) AS field
        WHERE field.key NOT IN ('type', 'artifact')
      )
      AND (SELECT count(*) FROM json_each(new.content)) = 2
      AND (SELECT count(*) FROM json_each(json_extract(new.content, '$.artifact'))) = 5
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.metadata_json) AS field
        WHERE field.key NOT IN (
          'outputKey', 'generationArtifactId', 'generationJobId', 'generationTaskId',
          'evidenceEventId', 'workflowStepRunId', 'contentHash', 'mimeType', 'sizeBytes', 'kind'
        )
      )
      AND (SELECT count(*) FROM json_each(new.metadata_json)) = 10
      AND NOT EXISTS (
        SELECT 1 FROM json_each(event.payload_json) AS field
        WHERE field.key NOT IN ('artifactIds', 'generationJobId', 'workflowStepRunId')
      )
      AND (SELECT count(*) FROM json_each(event.payload_json)) = 3
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(new.content, '$.artifact')) AS ref
        WHERE ref.key NOT IN ('id', 'kind', 'mimeType', 'sizeBytes', 'contentHash')
      )
      AND (
        json_type(new.content, '$.artifact.id') = 'text'
        AND json_type(new.content, '$.artifact.kind') = 'text'
        AND json_type(new.content, '$.artifact.mimeType') = 'text'
        AND json_type(new.content, '$.artifact.sizeBytes') = 'integer'
        AND json_type(new.content, '$.artifact.contentHash') = 'text'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'Generation ArtifactRef requires the completed same-Run Workflow Generation facts');
END;
