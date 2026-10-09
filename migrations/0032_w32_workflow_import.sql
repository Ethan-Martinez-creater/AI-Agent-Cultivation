-- W3.2 stores confirmed text imports as separate append-only provenance facts.
-- Mission-backed Workflow Artifact tables and their guards remain unchanged.

ALTER TABLE workflow_step_runs
  ADD COLUMN completion_origin TEXT NOT NULL DEFAULT 'EXECUTED'
  CHECK (completion_origin IN ('EXECUTED', 'IMPORTED_CONFIRMED'));

CREATE TABLE workflow_import_proposals (
  id TEXT PRIMARY KEY CHECK (id = trim(id) AND length(id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'CANCELLED', 'COMMITTED')),
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64 AND lower(version_hash) NOT GLOB '*[^0-9a-f]*'),
  input_snapshot_json TEXT NOT NULL CHECK (COALESCE(json_valid(input_snapshot_json) AND json_type(input_snapshot_json) = 'object' AND length(CAST(input_snapshot_json AS BLOB)) <= 32768, 0)),
  description TEXT NOT NULL CHECK (length(description) <= 6000),
  sources_json TEXT NOT NULL CHECK (COALESCE(json_valid(sources_json) AND json_type(sources_json) = 'array' AND json_array_length(sources_json) <= 16 AND length(CAST(sources_json AS BLOB)) <= 1100000, 0)),
  resolution_json TEXT NOT NULL CHECK (COALESCE(json_valid(resolution_json) AND json_type(resolution_json) = 'object' AND length(CAST(resolution_json AS BLOB)) <= 160000, 0)),
  source_metadata_hash TEXT NOT NULL CHECK (length(source_metadata_hash) = 64 AND lower(source_metadata_hash) NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALID', 'INVALID')),
  validation_errors_json TEXT NOT NULL CHECK (COALESCE(json_valid(validation_errors_json) AND json_type(validation_errors_json) = 'array' AND json_array_length(validation_errors_json) <= 64 AND length(CAST(validation_errors_json AS BLOB)) <= 32768, 0)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (definition_id, definition_version) REFERENCES workflow_versions(definition_id, version) ON DELETE RESTRICT,
  CHECK ((status = 'COMMITTED' AND run_id IS NOT NULL) OR (status != 'COMMITTED' AND run_id IS NULL)),
  CHECK (status NOT IN ('VALIDATED', 'COMMITTED') OR validation_status = 'VALID'),
  CHECK (validation_status != 'VALID' OR json_array_length(validation_errors_json) = 0)
);
CREATE INDEX workflow_import_proposals_timeline_idx ON workflow_import_proposals(updated_at DESC, id);

CREATE TRIGGER workflow_import_proposals_version_guard_insert
BEFORE INSERT ON workflow_import_proposals
WHEN NOT EXISTS (SELECT 1 FROM workflow_versions v WHERE v.definition_id = new.definition_id AND v.version = new.definition_version AND v.content_hash = new.version_hash)
BEGIN SELECT RAISE(ABORT, 'Workflow Import proposal must pin an exact frozen version hash'); END;
CREATE TRIGGER workflow_import_proposals_version_guard_update
BEFORE UPDATE ON workflow_import_proposals
WHEN NOT EXISTS (SELECT 1 FROM workflow_versions v WHERE v.definition_id = new.definition_id AND v.version = new.definition_version AND v.content_hash = new.version_hash)
BEGIN SELECT RAISE(ABORT, 'Workflow Import proposal must retain an exact frozen version hash'); END;
CREATE TRIGGER workflow_import_proposals_update_guard
BEFORE UPDATE ON workflow_import_proposals
WHEN new.id IS NOT old.id OR new.definition_id IS NOT old.definition_id
  OR new.definition_version IS NOT old.definition_version OR new.version_hash IS NOT old.version_hash
  OR new.created_at IS NOT old.created_at OR new.revision != old.revision + 1
  OR old.status IN ('CANCELLED', 'COMMITTED')
  OR NOT ((old.status = 'DRAFT' AND new.status IN ('DRAFT', 'VALIDATED', 'CANCELLED'))
       OR (old.status = 'VALIDATED' AND new.status IN ('DRAFT', 'VALIDATED', 'CANCELLED', 'COMMITTED')))
  OR (new.status = 'COMMITTED' AND NOT EXISTS (SELECT 1 FROM workflow_import_confirmations c WHERE c.proposal_id = old.id AND c.run_id = new.run_id))
  OR (new.status != 'COMMITTED' AND new.run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Workflow Import proposal revisions and status transitions are guarded'); END;
CREATE TRIGGER workflow_import_proposals_no_delete BEFORE DELETE ON workflow_import_proposals
BEGIN SELECT RAISE(ABORT, 'Workflow Import proposals are retained'); END;

CREATE TABLE workflow_import_confirmations (
  id TEXT PRIMARY KEY CHECK (id = trim(id) AND length(id) BETWEEN 1 AND 256),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES workflow_import_proposals(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64 AND lower(version_hash) NOT GLOB '*[^0-9a-f]*'),
  source_metadata_hash TEXT NOT NULL CHECK (length(source_metadata_hash) = 64 AND lower(source_metadata_hash) NOT GLOB '*[^0-9a-f]*'),
  completed_step_ids_json TEXT NOT NULL CHECK (COALESCE(json_valid(completed_step_ids_json) AND json_type(completed_step_ids_json) = 'array' AND json_array_length(completed_step_ids_json) BETWEEN 1 AND 32 AND length(CAST(completed_step_ids_json AS BLOB)) <= 8192, 0)),
  current_step_id TEXT NOT NULL CHECK (length(trim(current_step_id)) BETWEEN 1 AND 256),
  bindings_json TEXT NOT NULL CHECK (COALESCE(json_valid(bindings_json) AND json_type(bindings_json) = 'array' AND json_array_length(bindings_json) <= 384 AND length(CAST(bindings_json AS BLOB)) <= 65536, 0)),
  mapping_hash TEXT NOT NULL CHECK (length(mapping_hash) = 64 AND lower(mapping_hash) NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128)
);
CREATE INDEX workflow_import_confirmations_run_idx ON workflow_import_confirmations(run_id, created_at, id);

CREATE TRIGGER workflow_import_confirmations_fresh_run_guard
BEFORE INSERT ON workflow_import_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_import_proposals p
  JOIN workflow_runs r ON r.id = new.run_id
  JOIN workflow_versions v ON v.definition_id = r.definition_id AND v.version = r.definition_version
  WHERE p.id = new.proposal_id AND p.status = 'VALIDATED' AND p.validation_status = 'VALID' AND p.run_id IS NULL
    AND p.policy_version = 'w3-2-text-prefix-v1'
    AND p.definition_id = r.definition_id AND p.definition_version = r.definition_version
    AND p.version_hash = new.version_hash AND v.content_hash = new.version_hash
    AND p.source_metadata_hash = new.source_metadata_hash AND p.input_snapshot_json = r.input_snapshot_json
    AND r.state = 'READY' AND r.wait_reason IS NULL
    AND (SELECT COUNT(*) FROM workflow_step_runs sr WHERE sr.workflow_run_id = r.id) =
        (SELECT COUNT(*) FROM workflow_steps s WHERE s.definition_id = r.definition_id AND s.version = r.definition_version)
    AND NOT EXISTS (SELECT 1 FROM workflow_step_runs sr WHERE sr.workflow_run_id = r.id AND (sr.state NOT IN ('PENDING', 'READY') OR sr.mission_id IS NOT NULL OR sr.mission_run_id IS NOT NULL))
    AND EXISTS (SELECT 1 FROM workflow_step_runs entry WHERE entry.workflow_run_id = r.id AND entry.step_id = v.entry_step_id AND entry.state = 'READY' AND entry.mission_id IS NULL AND entry.mission_run_id IS NULL)
    AND (SELECT COUNT(*) FROM workflow_events e WHERE e.workflow_run_id = r.id) = 1
    AND EXISTS (SELECT 1 FROM workflow_events e WHERE e.workflow_run_id = r.id AND e.type = 'workflow.created')
    AND NOT EXISTS (SELECT 1 FROM workflow_artifacts WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_import_artifacts WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_artifact_bindings WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_import_artifact_bindings WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_validation_receipts WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_import_validations WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_run_output_validations WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_decisions WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_checkpoints WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_step_operation_receipts WHERE workflow_run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_revision_traversals WHERE workflow_run_id = r.id)
    AND json_extract(new.completed_step_ids_json, '$[0]') = v.entry_step_id
    AND NOT EXISTS (
      SELECT 1 FROM json_each(new.completed_step_ids_json) completed
      WHERE completed.type != 'text' OR completed.value = new.current_step_id
        OR NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = completed.value AND s.type = 'TASK' AND s.effect_type = 'NONE' AND s.exit_condition = 'VALID_OUTPUTS')
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(new.completed_step_ids_json) completed
      WHERE NOT EXISTS (SELECT 1 FROM json_each(new.bindings_json) mapping WHERE json_extract(mapping.value, '$.stepId') = completed.value)
    )
    AND EXISTS (SELECT 1 FROM workflow_steps s WHERE s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = new.current_step_id)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(new.bindings_json) mapping
      WHERE json_type(mapping.value) != 'object'
        OR json_type(mapping.value, '$.stepId') IS NOT 'text'
        OR json_type(mapping.value, '$.outputKey') IS NOT 'text'
        OR json_type(mapping.value, '$.sourceId') IS NOT 'text'
        OR EXISTS (SELECT 1 FROM json_each(mapping.value) field WHERE field.key NOT IN ('stepId', 'outputKey', 'sourceId'))
        OR NOT EXISTS (
          SELECT 1 FROM workflow_steps s JOIN json_each(s.outputs_json) o
          WHERE s.definition_id = r.definition_id AND s.version = r.definition_version
            AND s.id = json_extract(mapping.value, '$.stepId') AND s.type = 'TASK'
            AND s.effect_type = 'NONE' AND s.exit_condition = 'VALID_OUTPUTS'
            AND EXISTS (SELECT 1 FROM json_each(new.completed_step_ids_json) c WHERE c.value = s.id)
            AND json_extract(o.value, '$.key') = json_extract(mapping.value, '$.outputKey')
            AND json_extract(o.value, '$.kind') IN ('TEXT', 'JSON')
            AND EXISTS (SELECT 1 FROM json_each(p.sources_json) src WHERE json_extract(src.value, '$.id') = json_extract(mapping.value, '$.sourceId') AND json_extract(src.value, '$.kind') = json_extract(o.value, '$.kind'))
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(new.bindings_json) a JOIN json_each(new.bindings_json) b ON CAST(a.key AS INTEGER) < CAST(b.key AS INTEGER)
      WHERE json_extract(a.value, '$.stepId') = json_extract(b.value, '$.stepId') AND json_extract(a.value, '$.outputKey') = json_extract(b.value, '$.outputKey')
    )
    AND (json_extract(v.version_json, '$.definition.source') = 'USER' OR (
      r.definition_id = 'official.research' AND r.definition_version = 1
      AND json_extract(v.version_json, '$.validationPolicy') = 'research-integrity-v1'
      AND json_array_length(new.completed_step_ids_json) = 1
      AND json_extract(new.completed_step_ids_json, '$[0]') = 'R01' AND new.current_step_id = 'R02'
    ))
)
BEGIN SELECT RAISE(ABORT, 'Workflow Import confirmation needs an exact valid proposal and a fresh unstarted Run'); END;

CREATE TRIGGER workflow_import_confirmations_no_update BEFORE UPDATE ON workflow_import_confirmations
BEGIN SELECT RAISE(ABORT, 'Workflow Import confirmations are immutable facts'); END;
CREATE TRIGGER workflow_import_confirmations_no_delete BEFORE DELETE ON workflow_import_confirmations
BEGIN SELECT RAISE(ABORT, 'Workflow Import confirmations are retained'); END;

CREATE TRIGGER workflow_step_runs_import_origin_guard
BEFORE UPDATE OF completion_origin ON workflow_step_runs
WHEN new.completion_origin IS NOT old.completion_origin AND NOT (
  old.completion_origin = 'EXECUTED' AND new.completion_origin = 'IMPORTED_CONFIRMED'
  AND new.mission_id IS NULL AND new.mission_run_id IS NULL
  AND EXISTS (SELECT 1 FROM workflow_import_confirmations c JOIN workflow_runs r ON r.id = c.run_id
    JOIN workflow_import_proposals p ON p.id = c.proposal_id AND p.status = 'COMMITTED' AND p.run_id = r.id
    WHERE r.id = new.workflow_run_id AND r.state = 'RUNNING'
      AND EXISTS (SELECT 1 FROM json_each(c.completed_step_ids_json) completed WHERE completed.value = new.step_id))
)
BEGIN SELECT RAISE(ABORT, 'Imported completion origin requires a confirmed prefix Step and no Mission'); END;

CREATE TABLE workflow_import_artifacts (
  id TEXT PRIMARY KEY CHECK (id = trim(id) AND length(id) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  producer_step_run_id TEXT NOT NULL,
  import_confirmation_id TEXT NOT NULL REFERENCES workflow_import_confirmations(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'JSON')),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 65536),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND lower(content_hash) NOT GLOB '*[^0-9a-f]*'),
  metadata_json TEXT NOT NULL CHECK (COALESCE(json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(CAST(metadata_json AS BLOB)) <= 8192, 0)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (producer_step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_import_artifacts_lineage_idx ON workflow_import_artifacts(workflow_run_id, producer_step_run_id, created_at, id);

CREATE TRIGGER workflow_import_artifacts_validate_insert
BEFORE INSERT ON workflow_import_artifacts
WHEN EXISTS (SELECT 1 FROM workflow_artifacts WHERE id = new.id)
  OR NOT EXISTS (
    SELECT 1 FROM workflow_import_confirmations c
    JOIN workflow_import_proposals p ON p.id = c.proposal_id
    JOIN workflow_runs r ON r.id = c.run_id
    JOIN workflow_step_runs producer ON producer.id = new.producer_step_run_id AND producer.workflow_run_id = new.workflow_run_id
    JOIN workflow_steps step ON step.definition_id = r.definition_id AND step.version = r.definition_version AND step.id = producer.step_id
    JOIN json_each(c.bindings_json) mapping ON json_extract(mapping.value, '$.stepId') = producer.step_id AND json_extract(mapping.value, '$.sourceId') = new.source_id
    JOIN json_each(step.outputs_json) output ON json_extract(output.value, '$.key') = json_extract(mapping.value, '$.outputKey')
    JOIN json_each(p.sources_json) source ON json_extract(source.value, '$.id') = new.source_id
    WHERE c.id = new.import_confirmation_id AND c.run_id = new.workflow_run_id
      AND p.status = 'COMMITTED' AND p.run_id = new.workflow_run_id
      AND p.version_hash = c.version_hash AND p.source_metadata_hash = c.source_metadata_hash
      AND producer.state = 'RUNNING' AND producer.completion_origin = 'IMPORTED_CONFIRMED'
      AND producer.mission_id IS NULL AND producer.mission_run_id IS NULL
      AND step.type = 'TASK' AND step.effect_type = 'NONE' AND step.exit_condition = 'VALID_OUTPUTS'
      AND EXISTS (SELECT 1 FROM json_each(c.completed_step_ids_json) completed WHERE completed.value = producer.step_id)
      AND json_extract(output.value, '$.kind') = new.kind
      AND json_extract(source.value, '$.name') = json_extract(new.metadata_json, '$.sourceName')
      AND json_extract(source.value, '$.kind') = new.kind
      AND json_extract(source.value, '$.contentHash') = json_extract(new.metadata_json, '$.sourceContentHash')
      AND json_extract(source.value, '$.size') = json_extract(new.metadata_json, '$.sizeBytes')
      AND json_extract(new.metadata_json, '$.snapshot') = 1
      AND json_extract(new.metadata_json, '$.importConfirmationId') = new.import_confirmation_id
      AND (SELECT COUNT(*) FROM json_each(new.metadata_json)) = 5
      AND new.content = json_extract(source.value, '$.content')
      AND length(CAST(new.content AS BLOB)) = json_extract(source.value, '$.size')
  )
BEGIN SELECT RAISE(ABORT, 'Imported Artifact must match its confirmed source and frozen TASK output'); END;
CREATE TRIGGER workflow_import_artifacts_no_update BEFORE UPDATE ON workflow_import_artifacts
BEGIN SELECT RAISE(ABORT, 'Imported Workflow Artifacts are immutable facts'); END;
CREATE TRIGGER workflow_import_artifacts_no_delete BEFORE DELETE ON workflow_import_artifacts
BEGIN SELECT RAISE(ABORT, 'Imported Workflow Artifacts are retained'); END;

CREATE TABLE workflow_import_artifact_bindings (
  id TEXT PRIMARY KEY CHECK (id = trim(id) AND length(id) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(trim(key)) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('INPUT', 'OUTPUT')),
  contract_id TEXT NOT NULL CHECK (length(trim(contract_id)) BETWEEN 1 AND 256),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
  import_confirmation_id TEXT NOT NULL REFERENCES workflow_import_confirmations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (step_run_id, key, role),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, workflow_run_id) REFERENCES workflow_import_artifacts(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_import_artifact_bindings_artifact_idx ON workflow_import_artifact_bindings(artifact_id, role, workflow_run_id);

CREATE TRIGGER workflow_import_artifact_bindings_validate_insert
BEFORE INSERT ON workflow_import_artifact_bindings
WHEN EXISTS (SELECT 1 FROM workflow_artifact_bindings b WHERE b.step_run_id = new.step_run_id AND b.key = new.key AND b.role = new.role)
  OR NOT EXISTS (
    SELECT 1 FROM workflow_step_runs sr
    JOIN workflow_runs r ON r.id = sr.workflow_run_id
    JOIN workflow_steps s ON s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = sr.step_id
    JOIN workflow_import_artifacts a ON a.id = new.artifact_id AND a.workflow_run_id = new.workflow_run_id
    JOIN workflow_import_confirmations c ON c.id = a.import_confirmation_id AND c.run_id = a.workflow_run_id
    WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
      AND new.import_confirmation_id = a.import_confirmation_id
      AND ((new.role = 'OUTPUT' AND sr.state = 'RUNNING' AND sr.completion_origin = 'IMPORTED_CONFIRMED'
        AND a.producer_step_run_id = sr.id AND s.type = 'TASK' AND s.effect_type = 'NONE' AND s.exit_condition = 'VALID_OUTPUTS'
        AND EXISTS (SELECT 1 FROM json_each(s.outputs_json) o WHERE json_extract(o.value, '$.key') = new.key AND json_extract(o.value, '$.contractId') = new.contract_id AND json_extract(o.value, '$.contractVersion') = new.contract_version AND json_extract(o.value, '$.kind') = a.kind)
        AND EXISTS (SELECT 1 FROM json_each(c.bindings_json) m WHERE json_extract(m.value, '$.stepId') = sr.step_id AND json_extract(m.value, '$.outputKey') = new.key AND json_extract(m.value, '$.sourceId') = a.source_id))
      OR (new.role = 'INPUT' AND r.state = 'RUNNING'
        AND (
          (sr.state = 'READY' AND sr.completion_origin = 'EXECUTED')
          OR (sr.state = 'RUNNING' AND sr.completion_origin = 'IMPORTED_CONFIRMED'
            AND EXISTS (
              SELECT 1 FROM workflow_import_confirmations confirmation
              JOIN workflow_import_proposals proposal ON proposal.id = confirmation.proposal_id
              WHERE confirmation.id = new.import_confirmation_id AND confirmation.run_id = r.id
                AND proposal.status = 'COMMITTED' AND proposal.run_id = r.id
                AND EXISTS (SELECT 1 FROM json_each(confirmation.completed_step_ids_json) current_step WHERE current_step.value = sr.step_id)
            ))
        )
        AND EXISTS (
          SELECT 1 FROM workflow_step_runs producer
          JOIN workflow_steps ps ON ps.definition_id = r.definition_id AND ps.version = r.definition_version AND ps.id = producer.step_id
          JOIN json_each(s.inputs_json) i ON json_extract(i.value, '$.key') = new.key AND json_extract(i.value, '$.fromStepId') = producer.step_id
          JOIN workflow_import_artifact_bindings ob ON ob.step_run_id = producer.id AND ob.workflow_run_id = producer.workflow_run_id AND ob.artifact_id = a.id AND ob.role = 'OUTPUT'
          JOIN json_each(ps.outputs_json) o ON json_extract(o.value, '$.key') = ob.key
          JOIN workflow_import_validations v ON v.step_run_id = producer.id AND v.workflow_run_id = producer.workflow_run_id AND v.artifact_id = a.id AND v.valid = 1 AND v.content_hash = a.content_hash
          WHERE producer.workflow_run_id = sr.workflow_run_id AND producer.state = 'COMPLETED' AND producer.completion_origin = 'IMPORTED_CONFIRMED'
            AND producer.attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest WHERE latest.workflow_run_id = producer.workflow_run_id AND latest.step_id = producer.step_id)
            AND json_extract(i.value, '$.outputKey') = ob.key AND json_extract(o.value, '$.contractId') = new.contract_id AND json_extract(o.value, '$.contractVersion') = new.contract_version
            AND v.import_confirmation_id = new.import_confirmation_id
        )))
  )
BEGIN SELECT RAISE(ABORT, 'Imported Artifact binding must match a confirmed output or declared input'); END;
CREATE TRIGGER workflow_import_artifact_bindings_no_update BEFORE UPDATE ON workflow_import_artifact_bindings
BEGIN SELECT RAISE(ABORT, 'Imported Artifact bindings are immutable facts'); END;
CREATE TRIGGER workflow_import_artifact_bindings_no_delete BEFORE DELETE ON workflow_import_artifact_bindings
BEGIN SELECT RAISE(ABORT, 'Imported Artifact bindings are retained'); END;

CREATE TABLE workflow_import_validations (
  id TEXT PRIMARY KEY CHECK (id = trim(id) AND length(id) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  contract_id TEXT NOT NULL CHECK (length(trim(contract_id)) BETWEEN 1 AND 256),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) BETWEEN 1 AND 128),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND lower(content_hash) NOT GLOB '*[^0-9a-f]*'),
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT NOT NULL CHECK (COALESCE(json_valid(errors_json) AND json_type(errors_json) = 'array' AND json_array_length(errors_json) <= 64 AND length(CAST(errors_json AS BLOB)) <= 32768, 0)),
  import_confirmation_id TEXT NOT NULL REFERENCES workflow_import_confirmations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (step_run_id, artifact_id, contract_id, contract_version),
  FOREIGN KEY (step_run_id, workflow_run_id) REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, workflow_run_id) REFERENCES workflow_import_artifacts(id, workflow_run_id) ON DELETE RESTRICT,
  CHECK (valid = 0 OR json_array_length(errors_json) = 0)
);
CREATE INDEX workflow_import_validations_output_idx ON workflow_import_validations(step_run_id, artifact_id, valid, created_at);
CREATE TRIGGER workflow_import_validations_validate_insert
BEFORE INSERT ON workflow_import_validations
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_import_artifacts a
  JOIN workflow_step_runs sr ON sr.id = a.producer_step_run_id
  JOIN workflow_runs r ON r.id = sr.workflow_run_id
  JOIN workflow_steps s ON s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = sr.step_id
  JOIN json_each(s.outputs_json) o ON json_extract(o.value, '$.key') = (SELECT b.key FROM workflow_import_artifact_bindings b WHERE b.step_run_id = new.step_run_id AND b.workflow_run_id = new.workflow_run_id AND b.artifact_id = new.artifact_id AND b.role = 'OUTPUT')
  JOIN workflow_versions version ON version.definition_id = r.definition_id AND version.version = r.definition_version
  WHERE a.id = new.artifact_id AND a.workflow_run_id = new.workflow_run_id AND sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND a.import_confirmation_id = new.import_confirmation_id AND new.content_hash = a.content_hash
    AND new.contract_id = json_extract(o.value, '$.contractId') AND new.contract_version = json_extract(o.value, '$.contractVersion') AND json_extract(o.value, '$.kind') = a.kind
    AND new.validator_version = CASE WHEN json_extract(o.value, '$.validator.type') = 'REGISTRY'
      THEN (SELECT json_extract(c.value, '$.validatorVersion') FROM json_each(version.version_json, '$.contractManifest') c WHERE json_extract(c.value, '$.contractId') = new.contract_id AND json_extract(c.value, '$.contractVersion') = new.contract_version)
      ELSE 'w1-inline-validator-v1' END
)
BEGIN SELECT RAISE(ABORT, 'Import validation must match its frozen output validator and artifact hash'); END;
CREATE TRIGGER workflow_import_validations_no_update BEFORE UPDATE ON workflow_import_validations
BEGIN SELECT RAISE(ABORT, 'Import validations are immutable facts'); END;
CREATE TRIGGER workflow_import_validations_no_delete BEFORE DELETE ON workflow_import_validations
BEGIN SELECT RAISE(ABORT, 'Import validations are retained'); END;

CREATE TABLE workflow_import_artifact_inputs (
  artifact_id TEXT NOT NULL REFERENCES workflow_import_artifacts(id) ON DELETE RESTRICT,
  input_artifact_id TEXT NOT NULL REFERENCES workflow_import_artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, input_artifact_id)
);
CREATE TRIGGER workflow_import_artifact_inputs_validate_insert BEFORE INSERT ON workflow_import_artifact_inputs
WHEN NOT EXISTS (SELECT 1 FROM workflow_import_artifacts output JOIN workflow_import_artifact_bindings b ON b.step_run_id = output.producer_step_run_id AND b.workflow_run_id = output.workflow_run_id AND b.artifact_id = new.input_artifact_id AND b.role = 'INPUT' WHERE output.id = new.artifact_id)
BEGIN SELECT RAISE(ABORT, 'Imported Artifact lineage must follow a declared INPUT binding'); END;
CREATE TRIGGER workflow_import_artifact_inputs_no_update BEFORE UPDATE ON workflow_import_artifact_inputs
BEGIN SELECT RAISE(ABORT, 'Imported Artifact lineage is immutable'); END;
CREATE TRIGGER workflow_import_artifact_inputs_no_delete BEFORE DELETE ON workflow_import_artifact_inputs
BEGIN SELECT RAISE(ABORT, 'Imported Artifact lineage is retained'); END;

CREATE TABLE workflow_artifact_import_inputs (
  artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
  input_import_artifact_id TEXT NOT NULL REFERENCES workflow_import_artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, input_import_artifact_id)
);
CREATE TRIGGER workflow_artifact_import_inputs_validate_insert BEFORE INSERT ON workflow_artifact_import_inputs
WHEN NOT EXISTS (SELECT 1 FROM workflow_artifacts output JOIN workflow_import_artifact_bindings b ON b.step_run_id = output.producer_step_run_id AND b.workflow_run_id = output.workflow_run_id AND b.artifact_id = new.input_import_artifact_id AND b.role = 'INPUT' WHERE output.id = new.artifact_id)
BEGIN SELECT RAISE(ABORT, 'Executed Artifact import lineage must follow a declared INPUT binding'); END;
CREATE TRIGGER workflow_artifact_import_inputs_no_update BEFORE UPDATE ON workflow_artifact_import_inputs
BEGIN SELECT RAISE(ABORT, 'Executed Artifact import lineage is immutable'); END;
CREATE TRIGGER workflow_artifact_import_inputs_no_delete BEFORE DELETE ON workflow_artifact_import_inputs
BEGIN SELECT RAISE(ABORT, 'Executed Artifact import lineage is retained'); END;

CREATE TRIGGER workflow_artifact_bindings_import_collision_guard BEFORE INSERT ON workflow_artifact_bindings
WHEN EXISTS (SELECT 1 FROM workflow_import_artifact_bindings b WHERE b.step_run_id = new.step_run_id AND b.key = new.key AND b.role = new.role)
BEGIN SELECT RAISE(ABORT, 'Artifact binding keys are unique across provenance tables'); END;

CREATE VIEW workflow_imported_output_proofs AS
SELECT a.workflow_run_id AS workflow_run_id, producer.id AS step_run_id,
  producer.step_id AS step_id, producer.attempt AS attempt, a.id AS artifact_id,
  b.key AS output_key, b.contract_id AS contract_id, b.contract_version AS contract_version,
  a.kind AS kind, a.content_hash AS content_hash
FROM workflow_import_artifacts a
JOIN workflow_import_artifact_bindings b ON b.artifact_id = a.id AND b.workflow_run_id = a.workflow_run_id AND b.role = 'OUTPUT'
JOIN workflow_import_validations v ON v.workflow_run_id = a.workflow_run_id AND v.step_run_id = b.step_run_id
  AND v.artifact_id = a.id AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
  AND v.content_hash = a.content_hash AND v.valid = 1
JOIN workflow_step_runs producer ON producer.id = a.producer_step_run_id AND producer.workflow_run_id = a.workflow_run_id
JOIN workflow_runs r ON r.id = producer.workflow_run_id
JOIN workflow_steps s ON s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = producer.step_id
JOIN json_each(s.outputs_json) output ON json_extract(output.value, '$.key') = b.key
  AND json_extract(output.value, '$.contractId') = b.contract_id
  AND json_extract(output.value, '$.contractVersion') = b.contract_version
  AND json_extract(output.value, '$.kind') = a.kind
JOIN workflow_import_confirmations c ON c.id = a.import_confirmation_id AND c.run_id = a.workflow_run_id
WHERE producer.state = 'COMPLETED' AND producer.completion_origin = 'IMPORTED_CONFIRMED'
  AND producer.mission_id IS NULL AND producer.mission_run_id IS NULL
  AND s.type = 'TASK' AND s.effect_type = 'NONE' AND s.exit_condition = 'VALID_OUTPUTS'
  AND EXISTS (SELECT 1 FROM json_each(c.completed_step_ids_json) step WHERE step.value = producer.step_id)
  AND EXISTS (SELECT 1 FROM json_each(c.bindings_json) m WHERE json_extract(m.value, '$.stepId') = producer.step_id AND json_extract(m.value, '$.outputKey') = b.key AND json_extract(m.value, '$.sourceId') = a.source_id)
  AND producer.attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest WHERE latest.workflow_run_id = producer.workflow_run_id AND latest.step_id = producer.step_id);

CREATE VIEW workflow_run_validated_outputs AS
SELECT b.workflow_run_id AS workflow_run_id, producer.id AS step_run_id,
  producer.step_id AS step_id, producer.attempt AS attempt, b.key AS output_key,
  b.contract_id AS contract_id, b.contract_version AS contract_version,
  a.id AS artifact_id, a.kind AS kind, a.content_hash AS content_hash
FROM workflow_artifact_bindings b
JOIN workflow_artifacts a ON a.id = b.artifact_id AND a.workflow_run_id = b.workflow_run_id AND a.producer_step_run_id = b.step_run_id
JOIN workflow_step_runs producer ON producer.id = b.step_run_id AND producer.workflow_run_id = b.workflow_run_id
JOIN workflow_runs r ON r.id = producer.workflow_run_id
JOIN workflow_steps source_step ON source_step.definition_id = r.definition_id AND source_step.version = r.definition_version AND source_step.id = producer.step_id
JOIN json_each(source_step.outputs_json) source_spec ON json_extract(source_spec.value, '$.key') = b.key
  AND json_extract(source_spec.value, '$.contractId') = b.contract_id
  AND json_extract(source_spec.value, '$.contractVersion') = b.contract_version
  AND json_extract(source_spec.value, '$.kind') = a.kind
JOIN mission_runs mr ON mr.id = producer.mission_run_id AND mr.mission_id = producer.mission_id AND mr.status = 'COMPLETED'
JOIN missions m ON m.id = mr.mission_id AND m.state = 'COMPLETED'
JOIN workflow_validation_receipts receipt ON receipt.workflow_run_id = b.workflow_run_id AND receipt.step_run_id = producer.id
  AND receipt.artifact_id = a.id AND receipt.contract_id = b.contract_id AND receipt.contract_version = b.contract_version
  AND receipt.content_hash = a.content_hash AND receipt.valid = 1
WHERE b.role = 'OUTPUT' AND producer.state = 'COMPLETED' AND producer.completion_origin = 'EXECUTED'
  AND a.mission_id = producer.mission_id AND a.mission_run_id = producer.mission_run_id
  AND producer.attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest WHERE latest.workflow_run_id = producer.workflow_run_id AND latest.step_id = producer.step_id)
UNION ALL
SELECT workflow_run_id, step_run_id, step_id, attempt, output_key,
  contract_id, contract_version, artifact_id, kind, content_hash
FROM workflow_imported_output_proofs;

DROP TRIGGER workflow_step_runs_completion_guard;
CREATE TRIGGER workflow_step_runs_completion_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND new.completion_origin = 'EXECUTED' AND NOT EXISTS (
  SELECT 1 FROM workflow_runs AS r
  JOIN workflow_versions AS version ON version.definition_id = r.definition_id AND version.version = r.definition_version
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
           AND (COALESCE(json_extract(version.version_json,'$.validationPolicy') NOT IN ('news-integrity-v1','software-integrity-v1'),1) OR
             b.key = (SELECT COALESCE(json_extract(step.value,'$.reviewOutputKey'),
               (SELECT json_extract(candidate.value,'$.key') FROM json_each(step.value,'$.outputs') AS candidate
                 WHERE json_extract(candidate.value,'$.required') = 1 AND json_extract(candidate.value,'$.kind') = 'JSON' LIMIT 1))
               FROM json_each(version.version_json,'$.steps') AS step WHERE json_extract(step.value,'$.id') = new.step_id))
           AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
           AND v.content_hash = a.content_hash AND v.valid = 1
           AND json_valid(a.content) AND json_type(a.content) = 'object'
           AND (json_extract(a.content, '$.verdict') = 'PASS' OR (
             json_extract(version.version_json,'$.validationPolicy') IN ('news-integrity-v1','software-integrity-v1')
             AND json_extract(a.content,'$.verdict') = 'REVISE'
             AND EXISTS (
               SELECT 1 FROM workflow_decisions AS decision
               JOIN workflow_revision_traversals AS traversal ON traversal.step_run_id = decision.step_run_id
                 AND traversal.workflow_run_id = decision.workflow_run_id AND traversal.edge_id = decision.edge_id
               JOIN json_each(version.version_json,'$.edges') AS edge ON json_extract(edge.value,'$.id') = decision.edge_id
               WHERE decision.step_run_id = new.id AND decision.workflow_run_id = new.workflow_run_id
                 AND json_extract(edge.value,'$.fromStepId') = new.step_id
                 AND json_extract(edge.value,'$.toStepId') IS NOT NULL
                 AND json_extract(edge.value,'$.condition.type') = 'REVIEW_VERDICT'
                 AND json_extract(edge.value,'$.condition.verdict') = 'REVISE'
                 AND json_extract(edge.value,'$.revision.groupId') = traversal.group_id
                 AND json_extract(edge.value,'$.revision.maxTraversals') > 0
                 AND json_extract(edge.value,'$.revisionCode') IS json_extract(a.content,'$.revisionCode')
             )
           ))
           AND json_type(a.content, '$.findings') = 'array'
           AND json_type(a.content, '$.evidence') = 'array'
           AND json_type(a.content, '$.summary') = 'text'
           AND json_type(a.content, '$.reviewedArtifactIds') = 'array'
           AND NOT EXISTS (
             SELECT 1 FROM json_each(a.content) AS field
             WHERE field.key NOT IN ('verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds')
               AND NOT (field.key = 'revisionCode' AND json_extract(version.version_json,'$.validationPolicy') IN ('news-integrity-v1','software-integrity-v1'))
           )
       ))
     ))
  )
BEGIN
  SELECT RAISE(ABORT, 'completed Workflow StepRun needs validated outputs and a terminal Mission Run, or a Decision fact and checkpoint');
END;

CREATE TRIGGER workflow_step_runs_import_completion_guard
BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND new.completion_origin = 'IMPORTED_CONFIRMED' AND NOT EXISTS (
  SELECT 1 FROM workflow_runs r
  JOIN workflow_versions version ON version.definition_id = r.definition_id AND version.version = r.definition_version
  JOIN workflow_steps s ON s.definition_id = r.definition_id AND s.version = r.definition_version AND s.id = new.step_id
  JOIN workflow_import_confirmations c ON c.run_id = r.id
  JOIN workflow_import_proposals p ON p.id = c.proposal_id AND p.status = 'COMMITTED' AND p.run_id = r.id
  WHERE r.id = new.workflow_run_id AND r.state = 'RUNNING'
    AND p.version_hash = c.version_hash AND version.content_hash = c.version_hash
    AND p.source_metadata_hash = c.source_metadata_hash AND p.policy_version = 'w3-2-text-prefix-v1'
    AND new.mission_id IS NULL AND new.mission_run_id IS NULL
    AND new.attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest WHERE latest.workflow_run_id = r.id AND latest.step_id = new.step_id)
    AND s.type = 'TASK' AND s.effect_type = 'NONE' AND s.exit_condition = 'VALID_OUTPUTS'
    AND EXISTS (SELECT 1 FROM json_each(c.completed_step_ids_json) done WHERE done.value = new.step_id)
    AND EXISTS (SELECT 1 FROM workflow_checkpoints cp WHERE cp.workflow_run_id = r.id AND EXISTS (SELECT 1 FROM json_each(cp.completed_step_run_ids_json) done WHERE done.value = new.id))
    AND EXISTS (
      SELECT 1 FROM workflow_import_artifact_bindings b
      JOIN workflow_import_artifacts a ON a.id = b.artifact_id AND a.workflow_run_id = b.workflow_run_id
      JOIN workflow_import_validations v ON v.workflow_run_id = b.workflow_run_id AND v.step_run_id = b.step_run_id AND v.artifact_id = a.id
      JOIN json_each(s.outputs_json) spec ON json_extract(spec.value, '$.key') = b.key
        AND json_extract(spec.value, '$.contractId') = b.contract_id
        AND json_extract(spec.value, '$.contractVersion') = b.contract_version
        AND json_extract(spec.value, '$.kind') = a.kind
      WHERE b.workflow_run_id = r.id AND b.step_run_id = new.id AND b.role = 'OUTPUT'
        AND a.producer_step_run_id = new.id AND a.import_confirmation_id = c.id
        AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
        AND v.content_hash = a.content_hash AND v.valid = 1 AND v.import_confirmation_id = c.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(s.outputs_json) spec
      WHERE json_extract(spec.value, '$.required') = 1
        AND NOT EXISTS (
          SELECT 1 FROM workflow_import_artifact_bindings b
          JOIN workflow_import_artifacts a ON a.id = b.artifact_id AND a.workflow_run_id = b.workflow_run_id
          JOIN workflow_import_validations v ON v.workflow_run_id = b.workflow_run_id AND v.step_run_id = b.step_run_id AND v.artifact_id = a.id
          WHERE b.workflow_run_id = r.id AND b.step_run_id = new.id AND b.role = 'OUTPUT'
            AND b.key = json_extract(spec.value, '$.key') AND b.contract_id = json_extract(spec.value, '$.contractId')
            AND b.contract_version = json_extract(spec.value, '$.contractVersion') AND a.producer_step_run_id = new.id
            AND a.import_confirmation_id = c.id AND a.kind = json_extract(spec.value, '$.kind')
            AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
            AND v.content_hash = a.content_hash AND v.valid = 1 AND v.import_confirmation_id = c.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM workflow_import_artifact_bindings b
      WHERE b.workflow_run_id = r.id AND b.step_run_id = new.id AND b.role = 'OUTPUT'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_import_artifacts a
          JOIN workflow_import_validations v ON v.workflow_run_id = a.workflow_run_id AND v.step_run_id = b.step_run_id AND v.artifact_id = a.id
          WHERE a.id = b.artifact_id AND a.producer_step_run_id = new.id AND a.import_confirmation_id = c.id
            AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
            AND v.content_hash = a.content_hash AND v.valid = 1 AND v.import_confirmation_id = c.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(c.bindings_json) mapping
      WHERE json_extract(mapping.value, '$.stepId') = new.step_id
        AND NOT EXISTS (
          SELECT 1 FROM workflow_import_artifact_bindings b
          JOIN workflow_import_artifacts a ON a.id = b.artifact_id AND a.workflow_run_id = b.workflow_run_id
          JOIN workflow_import_validations v ON v.workflow_run_id = b.workflow_run_id AND v.step_run_id = b.step_run_id AND v.artifact_id = a.id
          WHERE b.workflow_run_id = r.id AND b.step_run_id = new.id AND b.role = 'OUTPUT'
            AND b.key = json_extract(mapping.value, '$.outputKey') AND a.source_id = json_extract(mapping.value, '$.sourceId')
            AND a.import_confirmation_id = c.id AND v.import_confirmation_id = c.id
            AND v.valid = 1 AND v.content_hash = a.content_hash
        )
    )
    AND NOT EXISTS (SELECT 1 FROM workflow_validation_receipts receipt WHERE receipt.workflow_run_id = r.id AND receipt.step_run_id = new.id)
    AND NOT EXISTS (SELECT 1 FROM workflow_step_operation_receipts receipt WHERE receipt.workflow_run_id = r.id AND receipt.step_run_id = new.id)
)
BEGIN SELECT RAISE(ABORT, 'imported completion requires confirmed mapped outputs, PASS validation, and checkpoint'); END;

DROP TRIGGER workflow_step_runs_w2_completion_guard;
CREATE TRIGGER workflow_step_runs_w2_completion_guard
BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND new.completion_origin = 'EXECUTED'
  AND EXISTS (SELECT 1 FROM workflow_runs run
    JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
    JOIN workflow_steps step ON step.definition_id = run.definition_id AND step.version = run.definition_version AND step.id = new.step_id
    WHERE run.id = new.workflow_run_id AND json_type(version.version_json, '$.contractManifest') = 'array' AND step.type != 'DECISION')
  AND (NOT EXISTS (SELECT 1 FROM workflow_step_operation_receipts receipt
      JOIN workflow_effective_step_types effective ON effective.step_run_id = receipt.step_run_id
      WHERE receipt.workflow_run_id = new.workflow_run_id AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt
        AND receipt.effect_type = effective.effect_type AND receipt.state = 'VERIFIED')
    OR EXISTS (SELECT 1 FROM workflow_step_operation_receipts receipt WHERE receipt.workflow_run_id = new.workflow_run_id
      AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt AND receipt.state != 'VERIFIED'))
BEGIN SELECT RAISE(ABORT, 'W2 StepRun completion requires verified operation receipts for effective execution'); END;

DROP TRIGGER workflow_run_output_validations_validate_insert;
CREATE TRIGGER workflow_run_output_validations_validate_insert
BEFORE INSERT ON workflow_run_output_validations
WHEN NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = new.workflow_run_id AND r.definition_version = new.definition_version AND r.state != 'COMPLETED')
  OR EXISTS (SELECT 1 FROM json_each(new.output_bindings_json) b WHERE json_type(b.value) != 'object'
    OR json_type(b.value, '$.key') IS NOT 'text' OR json_type(b.value, '$.artifactId') IS NOT 'text' OR json_type(b.value, '$.contentHash') IS NOT 'text'
    OR length(json_extract(b.value, '$.key')) NOT BETWEEN 1 AND 128 OR length(json_extract(b.value, '$.artifactId')) NOT BETWEEN 1 AND 256
    OR length(json_extract(b.value, '$.contentHash')) != 64 OR lower(json_extract(b.value, '$.contentHash')) GLOB '*[^0-9a-f]*'
    OR EXISTS (SELECT 1 FROM json_each(b.value) f WHERE f.key NOT IN ('key', 'artifactId', 'contentHash')))
  OR EXISTS (SELECT 1 FROM json_each(new.output_bindings_json) b GROUP BY json_extract(b.value, '$.key') HAVING COUNT(*) > 1)
  OR (new.valid = 1 AND (
    EXISTS (SELECT 1 FROM json_each(new.output_bindings_json) b
      WHERE NOT EXISTS (SELECT 1 FROM workflow_runs r JOIN workflow_versions v ON v.definition_id = r.definition_id AND v.version = r.definition_version
        JOIN json_each(v.version_json, '$.outputSchema.outputs') spec
        JOIN workflow_run_validated_outputs proof ON proof.workflow_run_id = r.id AND proof.output_key = json_extract(spec.value, '$.outputKey')
          AND proof.step_id = json_extract(spec.value, '$.fromStepId') AND proof.kind = json_extract(spec.value, '$.kind')
          AND proof.contract_id = json_extract(spec.value, '$.contractId') AND proof.contract_version = json_extract(spec.value, '$.contractVersion')
        WHERE r.id = new.workflow_run_id AND json_extract(b.value, '$.key') = json_extract(spec.value, '$.key')
          AND json_extract(b.value, '$.artifactId') = proof.artifact_id AND json_extract(b.value, '$.contentHash') = proof.content_hash))
    OR EXISTS (SELECT 1 FROM workflow_runs r JOIN workflow_versions v ON v.definition_id = r.definition_id AND v.version = r.definition_version
      JOIN json_each(v.version_json, '$.outputSchema.outputs') spec
      WHERE r.id = new.workflow_run_id AND json_extract(spec.value, '$.required') = 1
        AND NOT EXISTS (SELECT 1 FROM json_each(new.output_bindings_json) b JOIN workflow_run_validated_outputs proof
          ON proof.workflow_run_id = r.id AND proof.output_key = json_extract(spec.value, '$.outputKey')
            AND proof.step_id = json_extract(spec.value, '$.fromStepId') AND proof.kind = json_extract(spec.value, '$.kind')
            AND proof.contract_id = json_extract(spec.value, '$.contractId') AND proof.contract_version = json_extract(spec.value, '$.contractVersion')
            AND proof.artifact_id = json_extract(b.value, '$.artifactId') AND proof.content_hash = json_extract(b.value, '$.contentHash')
          WHERE json_extract(b.value, '$.key') = json_extract(spec.value, '$.key')))
  ))
BEGIN SELECT RAISE(ABORT, 'Workflow final validation must match its Run and declared executed or imported output bindings'); END;
