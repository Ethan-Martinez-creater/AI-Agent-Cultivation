-- W1 persists frozen Workflow versions and run facts. W2 may extend the
-- reserved contract metadata, but W1 has no registry or revision traversal.

CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),
  description TEXT NOT NULL CHECK (length(description) <= 6000),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (source IN ('BUILTIN', 'USER', 'IMPORTED')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128)
);
CREATE TRIGGER workflow_definitions_no_update BEFORE UPDATE ON workflow_definitions BEGIN
  SELECT RAISE(ABORT, 'Workflow definition identity is immutable');
END;
CREATE TRIGGER workflow_definitions_no_delete BEFORE DELETE ON workflow_definitions BEGIN
  SELECT RAISE(ABORT, 'Workflow definitions are retained');
END;

CREATE TABLE workflow_versions (
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  entry_step_id TEXT NOT NULL CHECK (length(trim(entry_step_id)) BETWEEN 1 AND 256),
  version_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(version_json) AND json_type(version_json) = 'object'
      AND length(CAST(version_json AS BLOB)) <= 120000, 0)
  ),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  PRIMARY KEY (definition_id, version)
);
CREATE INDEX workflow_versions_timeline_idx ON workflow_versions(definition_id, version DESC);
CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions BEGIN
  SELECT RAISE(ABORT, 'Workflow versions are immutable');
END;
CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions BEGIN
  SELECT RAISE(ABORT, 'Workflow versions are retained');
END;

CREATE TABLE workflow_steps (
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 256),
  type TEXT NOT NULL CHECK (type IN ('TASK', 'REVIEW', 'DECISION')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 256),
  objective TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 1 AND 6000),
  routing_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(routing_json) AND json_type(routing_json) = 'object'
      AND length(CAST(routing_json AS BLOB)) <= 16000, 0)
  ),
  inputs_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(inputs_json) AND json_type(inputs_json) = 'array'
      AND json_array_length(inputs_json) <= 12, 0)
  ),
  outputs_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(outputs_json) AND json_type(outputs_json) = 'array'
      AND json_array_length(outputs_json) <= 12, 0)
  ),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  exit_condition TEXT NOT NULL CHECK (exit_condition IN ('VALID_OUTPUTS', 'REVIEW_PASS')),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('NONE', 'FILE_OUTPUT', 'WORKSPACE_MUTATION', 'EXTERNAL_ACTION')),
  PRIMARY KEY (definition_id, version, id),
  FOREIGN KEY (definition_id, version) REFERENCES workflow_versions(definition_id, version) ON DELETE RESTRICT
);
CREATE TRIGGER workflow_steps_no_update BEFORE UPDATE ON workflow_steps BEGIN
  SELECT RAISE(ABORT, 'Workflow version Steps are immutable');
END;
CREATE TRIGGER workflow_steps_no_delete BEFORE DELETE ON workflow_steps BEGIN
  SELECT RAISE(ABORT, 'Workflow version Steps are retained');
END;

CREATE TABLE workflow_edges (
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 256),
  from_step_id TEXT NOT NULL,
  to_step_id TEXT,
  branch TEXT NOT NULL CHECK (length(trim(branch)) BETWEEN 1 AND 128),
  condition_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(condition_json) AND json_type(condition_json) = 'object'
      AND length(CAST(condition_json AS BLOB)) <= 2048, 0)
  ),
  revision_code TEXT CHECK (revision_code IS NULL),
  PRIMARY KEY (definition_id, version, id),
  FOREIGN KEY (definition_id, version) REFERENCES workflow_versions(definition_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (definition_id, version, from_step_id) REFERENCES workflow_steps(definition_id, version, id) ON DELETE RESTRICT,
  FOREIGN KEY (definition_id, version, to_step_id) REFERENCES workflow_steps(definition_id, version, id) ON DELETE RESTRICT
);
CREATE TRIGGER workflow_edges_no_update BEFORE UPDATE ON workflow_edges BEGIN
  SELECT RAISE(ABORT, 'Workflow version Edges are immutable');
END;
CREATE TRIGGER workflow_edges_no_delete BEFORE DELETE ON workflow_edges BEGIN
  SELECT RAISE(ABORT, 'Workflow version Edges are retained');
END;

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'READY', 'RUNNING', 'WAITING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('APPROVAL', 'EXTERNAL_WORK', 'USER_CONFIRMATION', 'MISSION', 'DECISION')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  UNIQUE (id, definition_version),
  FOREIGN KEY (definition_id, definition_version) REFERENCES workflow_versions(definition_id, version) ON DELETE RESTRICT
);
CREATE INDEX workflow_runs_timeline_idx ON workflow_runs(created_at, id);
CREATE TRIGGER workflow_runs_insert_state BEFORE INSERT ON workflow_runs
WHEN new.state != 'DRAFT' OR new.wait_reason IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Workflow Runs must start as DRAFT');
END;
CREATE TRIGGER workflow_runs_identity_immutable BEFORE UPDATE ON workflow_runs
WHEN new.id IS NOT old.id OR new.definition_id IS NOT old.definition_id
  OR new.definition_version IS NOT old.definition_version OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'Workflow Run identity and version pin are immutable');
END;
CREATE TRIGGER workflow_runs_transition BEFORE UPDATE OF state ON workflow_runs
WHEN new.state IS NOT old.state AND NOT (
  (old.state = 'DRAFT' AND new.state IN ('READY', 'CANCELLED')) OR
  (old.state = 'READY' AND new.state IN ('RUNNING', 'CANCELLED')) OR
  (old.state = 'RUNNING' AND new.state IN ('WAITING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')) OR
  (old.state = 'WAITING' AND new.state IN ('RUNNING', 'FAILED', 'CANCELLED')) OR
  (old.state = 'PAUSED' AND new.state IN ('RUNNING', 'CANCELLED')) OR
  (old.state = 'FAILED' AND new.state IN ('RUNNING', 'CANCELLED'))
) BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow Run lifecycle transition');
END;
CREATE TRIGGER workflow_runs_no_delete BEFORE DELETE ON workflow_runs BEGIN
  SELECT RAISE(ABORT, 'Workflow Runs are retained');
END;

CREATE TABLE workflow_step_runs (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_id TEXT NOT NULL CHECK (length(trim(step_id)) BETWEEN 1 AND 256),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'READY', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT
    CHECK (mission_id IS NULL OR length(trim(mission_id)) BETWEEN 1 AND 256),
  mission_run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT
    CHECK (mission_run_id IS NULL OR length(trim(mission_run_id)) BETWEEN 1 AND 256),
  workspace_root TEXT CHECK (workspace_root IS NULL OR length(trim(workspace_root)) BETWEEN 1 AND 4096),
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('APPROVAL', 'EXTERNAL_WORK', 'USER_CONFIRMATION', 'MISSION', 'DECISION')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  CHECK (mission_run_id IS NULL OR mission_id IS NOT NULL),
  UNIQUE (workflow_run_id, step_id, attempt),
  UNIQUE (id, workflow_run_id)
);
CREATE INDEX workflow_step_runs_mission_idx ON workflow_step_runs(mission_id, mission_run_id);
CREATE UNIQUE INDEX workflow_step_runs_mission_unique_idx
  ON workflow_step_runs(mission_id) WHERE mission_id IS NOT NULL;
CREATE TRIGGER workflow_step_runs_insert_guard BEFORE INSERT ON workflow_step_runs
WHEN new.state != 'PENDING' OR new.mission_id IS NOT NULL OR new.mission_run_id IS NOT NULL
  OR new.wait_reason IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM workflow_runs AS r
    JOIN workflow_steps AS s ON s.definition_id = r.definition_id
      AND s.version = r.definition_version AND s.id = new.step_id
    WHERE r.id = new.workflow_run_id
  ) BEGIN
  SELECT RAISE(ABORT, 'Workflow StepRun must start unbound and reference its pinned version Step');
END;
CREATE TRIGGER workflow_step_runs_identity_immutable BEFORE UPDATE ON workflow_step_runs
WHEN new.id IS NOT old.id OR new.workflow_run_id IS NOT old.workflow_run_id
  OR new.step_id IS NOT old.step_id OR new.attempt IS NOT old.attempt
  OR new.created_at IS NOT old.created_at
  OR (old.mission_id IS NOT NULL AND new.mission_id IS NOT old.mission_id)
  OR (old.mission_id IS NOT NULL AND new.workspace_root IS NOT old.workspace_root)
  OR (old.mission_id IS NULL AND new.mission_id IS NULL AND new.workspace_root IS NOT old.workspace_root)
  OR (old.mission_id IS NULL AND new.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM missions AS m WHERE m.id = new.mission_id
  )) BEGIN
  SELECT RAISE(ABORT, 'Workflow StepRun identity and first Mission binding are immutable');
END;
CREATE TRIGGER workflow_step_runs_mission_run_guard BEFORE UPDATE OF mission_run_id ON workflow_step_runs
WHEN new.mission_run_id IS NOT old.mission_run_id AND (
  new.mission_run_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM mission_runs AS mr
    WHERE mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
      AND (old.mission_run_id IS NULL OR (
        mr.attempt > (SELECT prior.attempt FROM mission_runs AS prior WHERE prior.id = old.mission_run_id)
        AND (SELECT prior.status FROM mission_runs AS prior WHERE prior.id = old.mission_run_id) != 'RUNNING'
      ))
  )) BEGIN
  SELECT RAISE(ABORT, 'Workflow StepRun may only bind a later Run of its bound Mission');
END;
CREATE TRIGGER workflow_step_runs_transition BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state IS NOT old.state AND NOT (
  (old.state = 'PENDING' AND new.state IN ('READY', 'SKIPPED', 'CANCELLED')) OR
  (old.state = 'READY' AND new.state IN ('RUNNING', 'CANCELLED')) OR
  (old.state = 'RUNNING' AND new.state IN ('WAITING', 'COMPLETED', 'FAILED', 'CANCELLED')) OR
  (old.state = 'WAITING' AND new.state IN ('RUNNING', 'FAILED', 'CANCELLED')) OR
  (old.state = 'FAILED' AND new.state = 'READY')
) BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow StepRun lifecycle transition');
END;
CREATE TRIGGER workflow_step_runs_completion_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND NOT EXISTS (
  SELECT 1 FROM workflow_runs AS r
  JOIN workflow_steps AS s ON s.definition_id = r.definition_id
    AND s.version = r.definition_version AND s.id = new.step_id
  WHERE r.id = new.workflow_run_id AND (
    (s.type = 'DECISION'
      AND EXISTS (SELECT 1 FROM workflow_decisions AS d
        WHERE d.workflow_run_id = new.workflow_run_id AND d.step_run_id = new.id)
      AND EXISTS (SELECT 1 FROM workflow_checkpoints AS c
        WHERE c.workflow_run_id = new.workflow_run_id
          AND EXISTS (SELECT 1 FROM json_each(c.completed_step_run_ids_json) AS completed
            WHERE completed.value = new.id)))
    OR (s.type != 'DECISION'
      AND new.mission_run_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM mission_runs AS mr
         JOIN missions AS m ON m.id = mr.mission_id
         WHERE mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
           AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED')
       AND EXISTS (SELECT 1 FROM workflow_checkpoints AS c
         WHERE c.workflow_run_id = new.workflow_run_id
           AND EXISTS (SELECT 1 FROM json_each(c.completed_step_run_ids_json) AS completed
             WHERE completed.value = new.id))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(s.outputs_json) AS spec
        WHERE json_extract(spec.value, '$.required') = 1
          AND NOT EXISTS (
            SELECT 1 FROM workflow_artifact_bindings AS b
            JOIN workflow_artifacts AS a ON a.id = b.artifact_id
              AND a.workflow_run_id = b.workflow_run_id
            JOIN workflow_validation_receipts AS v ON v.artifact_id = a.id
              AND v.workflow_run_id = a.workflow_run_id AND v.step_run_id = b.step_run_id
            WHERE b.workflow_run_id = new.workflow_run_id AND b.step_run_id = new.id
              AND b.role = 'OUTPUT' AND b.key = json_extract(spec.value, '$.key')
              AND b.contract_id = json_extract(spec.value, '$.contractId')
              AND b.contract_version = json_extract(spec.value, '$.contractVersion')
              AND a.kind = json_extract(spec.value, '$.kind')
              AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
              AND v.content_hash = a.content_hash AND v.valid = 1
          )
       )
       AND (s.exit_condition != 'REVIEW_PASS' OR EXISTS (
         SELECT 1
         FROM workflow_artifact_bindings AS b
         JOIN workflow_artifacts AS a ON a.id = b.artifact_id
           AND a.workflow_run_id = b.workflow_run_id
         JOIN workflow_validation_receipts AS v ON v.artifact_id = a.id
           AND v.workflow_run_id = a.workflow_run_id AND v.step_run_id = b.step_run_id
         JOIN json_each(s.outputs_json) AS spec
         WHERE b.workflow_run_id = new.workflow_run_id AND b.step_run_id = new.id
           AND b.role = 'OUTPUT' AND b.key = json_extract(spec.value, '$.key')
           AND b.contract_id = json_extract(spec.value, '$.contractId')
           AND b.contract_version = json_extract(spec.value, '$.contractVersion')
           AND json_extract(spec.value, '$.required') = 1
           AND json_extract(spec.value, '$.kind') = 'JSON' AND a.kind = 'JSON'
           AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
           AND v.content_hash = a.content_hash AND v.valid = 1
           AND json_valid(a.content) AND json_type(a.content) = 'object'
           AND json_extract(a.content, '$.verdict') = 'PASS'
           AND json_type(a.content, '$.findings') = 'array'
           AND json_type(a.content, '$.evidence') = 'array'
           AND json_type(a.content, '$.summary') = 'text'
           AND json_type(a.content, '$.reviewedArtifactIds') = 'array'
           AND NOT EXISTS (
             SELECT 1 FROM json_each(a.content) AS field
             WHERE field.key NOT IN ('verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds')
           )
       ))
     ))
  )
BEGIN
  SELECT RAISE(ABORT, 'completed Workflow StepRun needs validated outputs and a terminal Mission Run, or a Decision fact and checkpoint');
END;
CREATE TRIGGER workflow_step_runs_no_delete BEFORE DELETE ON workflow_step_runs BEGIN
  SELECT RAISE(ABORT, 'Workflow StepRuns are retained');
END;

CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  producer_step_run_id TEXT NOT NULL REFERENCES workflow_step_runs(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
  source TEXT NOT NULL CHECK (source IN ('MISSION', 'HUMAN_BRIDGE')),
  kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'JSON', 'FILE', 'DIRECTORY', 'EXTERNAL_REFERENCE')),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 1000000),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  metadata_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(metadata_json) AND json_type(metadata_json) = 'object'
      AND length(CAST(metadata_json AS BLOB)) <= 8192, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (id, workflow_run_id)
);
CREATE INDEX workflow_artifacts_lineage_idx ON workflow_artifacts(workflow_run_id, producer_step_run_id, created_at, id);
CREATE TRIGGER workflow_artifacts_validate_insert BEFORE INSERT ON workflow_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  WHERE sr.id = new.producer_step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.state = 'RUNNING' AND sr.mission_id = new.mission_id AND sr.mission_run_id = new.mission_run_id
) OR NOT (
  (new.source = 'MISSION' AND EXISTS (
    SELECT 1 FROM mission_runs AS mr
    JOIN missions AS m ON m.id = mr.mission_id
    JOIN workflow_step_runs AS sr ON sr.id = new.producer_step_run_id
      AND sr.workflow_run_id = new.workflow_run_id
    JOIN workflow_runs AS wr ON wr.id = sr.workflow_run_id
    JOIN workflow_steps AS ws ON ws.definition_id = wr.definition_id
      AND ws.version = wr.definition_version AND ws.id = sr.step_id
    WHERE mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
       AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED'
       AND m.coordinator_teammate_id = new.actor_id
      AND new.source_id = mr.id AND (
         (new.kind IN ('TEXT', 'JSON') AND mr.result_text IS new.content
           AND EXISTS (
             SELECT 1 FROM json_each(ws.outputs_json) AS spec
             WHERE json_extract(spec.value, '$.kind') = new.kind
               AND (json_type(new.metadata_json, '$.outputKey') IS NULL OR (
                 json_type(new.metadata_json, '$.outputKey') = 'text'
                 AND json_extract(spec.value, '$.key') = json_extract(new.metadata_json, '$.outputKey')
               ))
           )) OR EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN json_valid(mr.result_text) THEN mr.result_text ELSE '{"outputs":{}}' END, '$.outputs') AS output
          JOIN json_each(ws.outputs_json) AS spec
          WHERE output.key = json_extract(new.metadata_json, '$.outputKey')
            AND output.key = json_extract(spec.value, '$.key')
            AND json_extract(spec.value, '$.kind') = new.kind
            AND (
              (new.kind = 'TEXT' AND output.type = 'text' AND output.value = new.content)
              OR (new.kind = 'JSON' AND json_valid(new.content)
                AND json(new.content) = json(output.value))
            )
        )
      )
  ))
  OR (new.source = 'HUMAN_BRIDGE' AND new.kind = 'TEXT' AND (
    EXISTS (
      SELECT 1 FROM mission_runs AS mr JOIN missions AS m ON m.id = mr.mission_id
      JOIN teammates AS t ON t.id = m.coordinator_teammate_id
      WHERE mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
       AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED' AND mr.result_text IS new.content
        AND m.coordinator_teammate_id = new.actor_id AND new.source_id = mr.id
        AND t.system_kind = 'HUMAN_BRIDGE' AND t.executor_kind = 'USER_BRIDGE'
    ) OR EXISTS (
      SELECT 1 FROM external_work_requests AS req
      JOIN mission_runs AS mr ON mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
      JOIN missions AS m ON m.id = mr.mission_id
      WHERE req.id = new.source_id AND req.state = 'ACCEPTED'
        AND req.mission_id = new.mission_id AND req.run_id = new.mission_run_id
        AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED'
        AND req.assignee_teammate_id = new.actor_id AND req.public_result IS new.content
    )
  ))
  OR (new.source = 'HUMAN_BRIDGE' AND new.kind = 'FILE' AND EXISTS (
    SELECT 1 FROM external_work_artifacts AS ext
    JOIN external_work_requests AS req ON req.id = ext.external_work_request_id
    WHERE ext.id = new.source_id AND req.state = 'ACCEPTED'
      AND ext.submitted_at = req.submitted_at
      AND req.mission_id = new.mission_id AND req.run_id = new.mission_run_id
      AND req.assignee_teammate_id = new.actor_id
      AND json_extract(new.metadata_json, '$.path') = ext.path
      AND json_extract(new.metadata_json, '$.fileName') = ext.file_name
      AND json_extract(new.metadata_json, '$.extension') = ext.extension
      AND json_extract(new.metadata_json, '$.sizeBytes') = ext.size_bytes
      AND json_extract(new.metadata_json, '$.targetArtifactId') = json_extract(ext.metadata_json, '$.targetArtifactId')
      AND json_type(new.metadata_json, '$.contentHash') = 'text'
      AND length(json_extract(new.metadata_json, '$.contentHash')) = 64
      AND lower(json_extract(new.metadata_json, '$.contentHash')) NOT GLOB '*[^0-9a-f]*'
      AND new.content = ''
  ))
) OR EXISTS (
  SELECT 1 FROM json_each(new.metadata_json) AS field
  WHERE replace(replace(lower(field.key), '_', ''), '-', '') LIKE '%privatememory%'
) BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact source, Run binding, actor, or metadata provenance is invalid');
END;
CREATE TRIGGER workflow_artifacts_no_update BEFORE UPDATE ON workflow_artifacts BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifacts are immutable facts');
END;
CREATE TRIGGER workflow_artifacts_no_delete BEFORE DELETE ON workflow_artifacts BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifacts are retained');
END;

CREATE TABLE workflow_artifact_inputs (
  artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
  input_artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, input_artifact_id),
  CHECK (artifact_id != input_artifact_id)
);
CREATE TRIGGER workflow_artifact_inputs_no_update BEFORE UPDATE ON workflow_artifact_inputs BEGIN
  SELECT RAISE(ABORT, 'Artifact lineage is immutable');
END;
CREATE TRIGGER workflow_artifact_inputs_no_delete BEFORE DELETE ON workflow_artifact_inputs BEGIN
  SELECT RAISE(ABORT, 'Artifact lineage is retained');
END;

CREATE TABLE workflow_artifact_bindings (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(trim(key)) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('INPUT', 'OUTPUT')),
  contract_id TEXT NOT NULL CHECK (length(trim(contract_id)) BETWEEN 1 AND 256),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (step_run_id, key, role),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, workflow_run_id) REFERENCES workflow_artifacts(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_artifact_bindings_artifact_idx ON workflow_artifact_bindings(artifact_id, role, workflow_run_id);
CREATE TRIGGER workflow_artifact_bindings_validate_insert BEFORE INSERT ON workflow_artifact_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  JOIN workflow_runs AS r ON r.id = sr.workflow_run_id
  JOIN workflow_steps AS s ON s.definition_id = r.definition_id
    AND s.version = r.definition_version AND s.id = sr.step_id
  JOIN workflow_artifacts AS a ON a.id = new.artifact_id AND a.workflow_run_id = sr.workflow_run_id
  JOIN workflow_step_runs AS producer ON producer.id = a.producer_step_run_id
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id AND (
    (new.role = 'OUTPUT' AND producer.id = sr.id AND EXISTS (
      SELECT 1 FROM json_each(s.outputs_json) AS spec
      WHERE json_extract(spec.value, '$.key') = new.key
        AND json_extract(spec.value, '$.contractId') = new.contract_id
        AND json_extract(spec.value, '$.contractVersion') = new.contract_version
        AND json_extract(spec.value, '$.kind') = a.kind
    ))
    OR (new.role = 'INPUT' AND producer.workflow_run_id = sr.workflow_run_id
      AND producer.state = 'COMPLETED' AND EXISTS (
        SELECT 1 FROM json_each(s.inputs_json) AS spec
        JOIN workflow_steps AS producer_step ON producer_step.id = producer.step_id
        JOIN workflow_runs AS pinned ON pinned.id = sr.workflow_run_id
          AND producer_step.definition_id = pinned.definition_id
          AND producer_step.version = pinned.definition_version
        JOIN json_each(producer_step.outputs_json) AS output_spec
          ON json_extract(output_spec.value, '$.key') = json_extract(spec.value, '$.outputKey')
     JOIN workflow_artifact_bindings AS producer_binding
       ON producer_binding.step_run_id = producer.id
       AND producer_binding.workflow_run_id = producer.workflow_run_id
       AND producer_binding.artifact_id = a.id AND producer_binding.role = 'OUTPUT'
       AND producer_binding.key = json_extract(spec.value, '$.outputKey')
       AND producer_binding.contract_id = json_extract(output_spec.value, '$.contractId')
       AND producer_binding.contract_version = json_extract(output_spec.value, '$.contractVersion')
     JOIN workflow_validation_receipts AS producer_receipt
       ON producer_receipt.step_run_id = producer.id
       AND producer_receipt.workflow_run_id = producer.workflow_run_id
       AND producer_receipt.artifact_id = a.id AND producer_receipt.valid = 1
       AND producer_receipt.content_hash = a.content_hash
        WHERE json_extract(spec.value, '$.key') = new.key
          AND json_extract(spec.value, '$.fromStepId') = producer.step_id
          AND json_extract(output_spec.value, '$.contractId') = new.contract_id
          AND json_extract(output_spec.value, '$.contractVersion') = new.contract_version
          AND a.producer_step_run_id = producer.id
      ))
  )
) BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact binding must match a declared input/output and its producer');
END;
CREATE TRIGGER workflow_artifact_bindings_no_update BEFORE UPDATE ON workflow_artifact_bindings BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact bindings are immutable facts');
END;
CREATE TRIGGER workflow_artifact_bindings_no_delete BEFORE DELETE ON workflow_artifact_bindings BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact bindings are retained');
END;
CREATE TRIGGER workflow_artifact_inputs_validate_insert BEFORE INSERT ON workflow_artifact_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_artifacts AS produced
  JOIN workflow_artifact_bindings AS b ON b.step_run_id = produced.producer_step_run_id
  WHERE produced.id = new.artifact_id AND b.role = 'INPUT' AND b.artifact_id = new.input_artifact_id
) BEGIN
  SELECT RAISE(ABORT, 'Artifact lineage must reference a declared INPUT binding');
END;

CREATE TABLE workflow_validation_receipts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  contract_id TEXT NOT NULL CHECK (length(trim(contract_id)) BETWEEN 1 AND 256),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) BETWEEN 1 AND 128),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(errors_json) AND json_type(errors_json) = 'array'
      AND json_array_length(errors_json) <= 64
      AND length(CAST(errors_json AS BLOB)) <= 8192, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, workflow_run_id) REFERENCES workflow_artifacts(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_validation_receipts_output_idx ON workflow_validation_receipts(step_run_id, artifact_id, valid, created_at);
CREATE TRIGGER workflow_validation_receipts_validate_insert BEFORE INSERT ON workflow_validation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_artifacts AS a
  JOIN workflow_step_runs AS sr ON sr.id = a.producer_step_run_id
  WHERE a.id = new.artifact_id AND a.workflow_run_id = new.workflow_run_id
    AND sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND a.content_hash = new.content_hash
) BEGIN
  SELECT RAISE(ABORT, 'Workflow validation receipt must match its produced Artifact hash and StepRun');
END;
CREATE TRIGGER workflow_validation_receipts_no_update BEFORE UPDATE ON workflow_validation_receipts BEGIN
  SELECT RAISE(ABORT, 'Workflow validation receipts are append-only');
END;
CREATE TRIGGER workflow_validation_receipts_no_delete BEFORE DELETE ON workflow_validation_receipts BEGIN
  SELECT RAISE(ABORT, 'Workflow validation receipts are retained');
END;

CREATE TABLE workflow_decisions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  branch TEXT NOT NULL CHECK (length(trim(branch)) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (step_run_id),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_decisions_timeline_idx ON workflow_decisions(workflow_run_id, created_at, id);
CREATE TRIGGER workflow_decisions_validate_insert BEFORE INSERT ON workflow_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  JOIN workflow_runs AS r ON r.id = sr.workflow_run_id
  JOIN workflow_steps AS s ON s.definition_id = r.definition_id
    AND s.version = r.definition_version AND s.id = sr.step_id
  JOIN workflow_edges AS e ON e.definition_id = r.definition_id
    AND e.version = r.definition_version AND e.id = new.edge_id
    AND e.from_step_id = sr.step_id AND e.branch = new.branch
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.state = 'RUNNING'
) BEGIN
  SELECT RAISE(ABORT, 'Workflow decision must match a declared Step edge');
END;
CREATE TRIGGER workflow_decisions_no_update BEFORE UPDATE ON workflow_decisions BEGIN
  SELECT RAISE(ABORT, 'Workflow decision facts are append-only');
END;
CREATE TRIGGER workflow_decisions_no_delete BEFORE DELETE ON workflow_decisions BEGIN
  SELECT RAISE(ABORT, 'Workflow decision facts are retained');
END;

CREATE TABLE workflow_checkpoints (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  completed_step_run_ids_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(completed_step_run_ids_json) AND json_type(completed_step_run_ids_json) = 'array'
      AND json_array_length(completed_step_run_ids_json) <= 32
      AND length(CAST(completed_step_run_ids_json AS BLOB)) <= 8192, 0)
  ),
  active_step_run_ids_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(active_step_run_ids_json) AND json_type(active_step_run_ids_json) = 'array'
      AND json_array_length(active_step_run_ids_json) <= 32
      AND length(CAST(active_step_run_ids_json AS BLOB)) <= 8192, 0)
  ),
  artifact_binding_hashes_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(artifact_binding_hashes_json) AND json_type(artifact_binding_hashes_json) = 'array'
      AND json_array_length(artifact_binding_hashes_json) <= 384
      AND length(CAST(artifact_binding_hashes_json AS BLOB)) <= 32768, 0)
  ),
  decision_hashes_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(decision_hashes_json) AND json_type(decision_hashes_json) = 'array'
      AND json_array_length(decision_hashes_json) <= 32
      AND length(CAST(decision_hashes_json AS BLOB)) <= 8192, 0)
  ),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (workflow_run_id, sequence),
  FOREIGN KEY (workflow_run_id, definition_version) REFERENCES workflow_runs(id, definition_version) ON DELETE RESTRICT
);
CREATE INDEX workflow_checkpoints_timeline_idx ON workflow_checkpoints(workflow_run_id, sequence);
CREATE TRIGGER workflow_checkpoints_validate_insert BEFORE INSERT ON workflow_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_runs AS r WHERE r.id = new.workflow_run_id AND r.definition_version = new.definition_version
) OR EXISTS (
  SELECT 1 FROM json_each(new.completed_step_run_ids_json) AS item
  WHERE item.type != 'text' OR NOT EXISTS (
    SELECT 1 FROM workflow_step_runs AS sr
    WHERE sr.id = item.value AND sr.workflow_run_id = new.workflow_run_id
      AND sr.state IN ('RUNNING', 'COMPLETED')
  )
) OR EXISTS (
  SELECT 1 FROM json_each(new.active_step_run_ids_json) AS item
  WHERE item.type != 'text' OR NOT EXISTS (
    SELECT 1 FROM workflow_step_runs AS sr
    WHERE sr.id = item.value AND sr.workflow_run_id = new.workflow_run_id
     AND sr.state IN ('READY', 'RUNNING', 'WAITING')
  )
) OR EXISTS (
  SELECT 1 FROM json_each(new.artifact_binding_hashes_json) AS item
  WHERE item.type != 'text' OR length(item.value) != 64
) OR EXISTS (
  SELECT 1 FROM json_each(new.decision_hashes_json) AS item
  WHERE item.type != 'text' OR length(item.value) != 64
) BEGIN
  SELECT RAISE(ABORT, 'Workflow checkpoint references invalid bounded run facts');
END;
CREATE TRIGGER workflow_checkpoints_no_update BEFORE UPDATE ON workflow_checkpoints BEGIN
  SELECT RAISE(ABORT, 'Workflow checkpoints are append-only');
END;
CREATE TRIGGER workflow_checkpoints_no_delete BEFORE DELETE ON workflow_checkpoints BEGIN
  SELECT RAISE(ABORT, 'Workflow checkpoints are retained');
END;

CREATE TABLE workflow_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT,
  type TEXT NOT NULL CHECK (length(trim(type)) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object'
      AND length(CAST(payload_json AS BLOB)) <= 4096, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_events_timeline_idx ON workflow_events(workflow_run_id, created_at, id);
CREATE TRIGGER workflow_events_validate_insert BEFORE INSERT ON workflow_events
WHEN EXISTS (
  SELECT 1 FROM json_each(new.payload_json) AS field
   WHERE replace(replace(lower(field.key), '_', ''), '-', '') LIKE '%privatememory%'
      OR field.type IN ('object', 'array')
     OR field.type NOT IN ('text', 'integer', 'real', 'true', 'false', 'null')
     OR (field.type = 'text' AND length(field.value) > 256)
) BEGIN
  SELECT RAISE(ABORT, 'Workflow event metadata is bounded and cannot contain privateMemory');
END;
CREATE TRIGGER workflow_events_no_update BEFORE UPDATE ON workflow_events BEGIN
  SELECT RAISE(ABORT, 'Workflow events are append-only');
END;
CREATE TRIGGER workflow_events_no_delete BEFORE DELETE ON workflow_events BEGIN
  SELECT RAISE(ABORT, 'Workflow events are retained');
END;
