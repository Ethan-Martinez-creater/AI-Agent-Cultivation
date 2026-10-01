-- W1 input snapshots are immutable Run facts. Final validation receipts record
-- the exact final artifact bindings checked against the Run's frozen version.

ALTER TABLE workflow_runs ADD COLUMN input_snapshot_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    COALESCE(json_valid(input_snapshot_json)
      AND json_type(input_snapshot_json) = 'object'
      AND length(CAST(input_snapshot_json AS BLOB)) <= 32768, 0)
  );

CREATE TRIGGER workflow_runs_input_snapshot_immutable BEFORE UPDATE ON workflow_runs
WHEN new.input_snapshot_json IS NOT old.input_snapshot_json BEGIN
  SELECT RAISE(ABORT, 'Workflow Run input snapshot is immutable');
END;

CREATE TRIGGER workflow_versions_identity_validate_insert BEFORE INSERT ON workflow_versions
WHEN json_extract(new.version_json, '$.definition.id') IS NOT new.definition_id
  OR json_extract(new.version_json, '$.definition.source') IS NOT (
    SELECT source FROM workflow_definitions WHERE id = new.definition_id
  ) BEGIN
  SELECT RAISE(ABORT, 'Workflow version definition id and source must match its immutable identity');
END;

CREATE TABLE workflow_run_output_validations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND lower(input_hash) NOT GLOB '*[^0-9a-f]*'),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64 AND lower(state_hash) NOT GLOB '*[^0-9a-f]*'),
  output_bindings_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(output_bindings_json)
      AND json_type(output_bindings_json) = 'array'
      AND json_array_length(output_bindings_json) <= 12
      AND length(CAST(output_bindings_json AS BLOB)) <= 8192, 0)
  ),
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(errors_json) AND json_type(errors_json) = 'array'
      AND json_array_length(errors_json) <= 64
      AND length(CAST(errors_json AS BLOB)) <= 8192, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (workflow_run_id, state_hash),
  FOREIGN KEY (workflow_run_id, definition_version)
    REFERENCES workflow_runs(id, definition_version) ON DELETE RESTRICT,
  CHECK (valid = 0 OR json_array_length(errors_json) = 0)
);
CREATE INDEX workflow_run_output_validations_timeline_idx
  ON workflow_run_output_validations(workflow_run_id, created_at, id);

CREATE TRIGGER workflow_run_output_validations_validate_insert
BEFORE INSERT ON workflow_run_output_validations
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_runs AS r
  WHERE r.id = new.workflow_run_id AND r.definition_version = new.definition_version
    AND r.state != 'COMPLETED'
) OR EXISTS (
  SELECT 1 FROM json_each(new.output_bindings_json) AS binding
  WHERE json_type(binding.value) != 'object'
    OR json_type(binding.value, '$.key') IS NOT 'text'
    OR json_type(binding.value, '$.artifactId') IS NOT 'text'
    OR json_type(binding.value, '$.contentHash') IS NOT 'text'
    OR length(json_extract(binding.value, '$.key')) NOT BETWEEN 1 AND 128
    OR length(json_extract(binding.value, '$.artifactId')) NOT BETWEEN 1 AND 256
    OR length(json_extract(binding.value, '$.contentHash')) != 64
    OR lower(json_extract(binding.value, '$.contentHash')) GLOB '*[^0-9a-f]*'
    OR EXISTS (
      SELECT 1 FROM json_each(binding.value) AS field
      WHERE field.key NOT IN ('key', 'artifactId', 'contentHash')
    )
) OR EXISTS (
  SELECT 1 FROM json_each(new.output_bindings_json) AS binding
  GROUP BY json_extract(binding.value, '$.key')
  HAVING COUNT(*) > 1
) OR (new.valid = 1 AND (
  EXISTS (
    SELECT 1 FROM json_each(new.output_bindings_json) AS binding
    WHERE NOT EXISTS (
      SELECT 1
      FROM workflow_runs AS r
      JOIN workflow_versions AS v ON v.definition_id = r.definition_id
        AND v.version = r.definition_version
      JOIN json_each(v.version_json, '$.outputSchema.outputs') AS spec
      JOIN workflow_artifact_bindings AS b ON b.workflow_run_id = r.id
        AND b.role = 'OUTPUT'
        AND b.key = json_extract(spec.value, '$.outputKey')
      JOIN workflow_artifacts AS a ON a.id = b.artifact_id
        AND a.workflow_run_id = b.workflow_run_id
        AND a.content_hash = json_extract(binding.value, '$.contentHash')
        AND a.kind = json_extract(spec.value, '$.kind')
        AND a.producer_step_run_id = b.step_run_id
      JOIN workflow_step_runs AS sr ON sr.id = b.step_run_id
        AND sr.workflow_run_id = b.workflow_run_id
        AND sr.step_id = json_extract(spec.value, '$.fromStepId')
        AND sr.state = 'COMPLETED'
        AND sr.attempt = (
          SELECT MAX(latest.attempt) FROM workflow_step_runs AS latest
          WHERE latest.workflow_run_id = sr.workflow_run_id AND latest.step_id = sr.step_id
        )
      JOIN workflow_steps AS source_step ON source_step.definition_id = r.definition_id
        AND source_step.version = r.definition_version AND source_step.id = sr.step_id
      JOIN json_each(source_step.outputs_json) AS source_spec
        ON json_extract(source_spec.value, '$.key') = json_extract(spec.value, '$.outputKey')
        AND json_extract(source_spec.value, '$.contractId') = b.contract_id
        AND json_extract(source_spec.value, '$.contractVersion') = b.contract_version
        AND json_extract(source_spec.value, '$.kind') = a.kind
      JOIN mission_runs AS mr ON mr.id = sr.mission_run_id
        AND mr.mission_id = sr.mission_id AND mr.status = 'COMPLETED'
      JOIN missions AS m ON m.id = mr.mission_id AND m.state = 'COMPLETED'
      JOIN workflow_validation_receipts AS receipt ON receipt.workflow_run_id = r.id
        AND receipt.step_run_id = sr.id AND receipt.artifact_id = a.id
        AND receipt.contract_id = b.contract_id AND receipt.contract_version = b.contract_version
        AND receipt.content_hash = a.content_hash AND receipt.valid = 1
      WHERE r.id = new.workflow_run_id
        AND json_extract(binding.value, '$.key') = json_extract(spec.value, '$.key')
        AND json_extract(binding.value, '$.artifactId') = a.id
        AND a.mission_id = sr.mission_id
        AND a.mission_run_id = sr.mission_run_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM workflow_runs AS r
    JOIN workflow_versions AS v ON v.definition_id = r.definition_id
      AND v.version = r.definition_version
    JOIN json_each(v.version_json, '$.outputSchema.outputs') AS spec
    WHERE r.id = new.workflow_run_id AND json_extract(spec.value, '$.required') = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.output_bindings_json) AS binding
        WHERE json_extract(binding.value, '$.key') = json_extract(spec.value, '$.key')
          AND EXISTS (
            SELECT 1
            FROM workflow_artifact_bindings AS b
            JOIN workflow_artifacts AS a ON a.id = b.artifact_id
              AND a.workflow_run_id = b.workflow_run_id
            JOIN workflow_step_runs AS sr ON sr.id = b.step_run_id
              AND sr.workflow_run_id = b.workflow_run_id
            JOIN workflow_steps AS source_step ON source_step.id = sr.step_id
              AND source_step.definition_id = r.definition_id
              AND source_step.version = r.definition_version
            JOIN json_each(source_step.outputs_json) AS source_spec
              ON json_extract(source_spec.value, '$.key') = json_extract(spec.value, '$.outputKey')
              AND json_extract(source_spec.value, '$.contractId') = b.contract_id
              AND json_extract(source_spec.value, '$.contractVersion') = b.contract_version
              AND json_extract(source_spec.value, '$.kind') = a.kind
            JOIN mission_runs AS mr ON mr.id = sr.mission_run_id
              AND mr.mission_id = sr.mission_id AND mr.status = 'COMPLETED'
            JOIN missions AS m ON m.id = mr.mission_id AND m.state = 'COMPLETED'
            JOIN workflow_validation_receipts AS receipt ON receipt.workflow_run_id = b.workflow_run_id
              AND receipt.step_run_id = sr.id AND receipt.artifact_id = a.id
              AND receipt.contract_id = b.contract_id AND receipt.contract_version = b.contract_version
              AND receipt.content_hash = a.content_hash AND receipt.valid = 1
            WHERE b.workflow_run_id = r.id AND b.role = 'OUTPUT'
              AND b.key = json_extract(spec.value, '$.outputKey')
              AND a.kind = json_extract(spec.value, '$.kind')
              AND a.id = json_extract(binding.value, '$.artifactId')
              AND a.content_hash = json_extract(binding.value, '$.contentHash')
              AND a.producer_step_run_id = sr.id
              AND a.mission_id = sr.mission_id
              AND a.mission_run_id = sr.mission_run_id
              AND sr.step_id = json_extract(spec.value, '$.fromStepId')
              AND sr.state = 'COMPLETED'
              AND sr.attempt = (
                SELECT MAX(latest.attempt) FROM workflow_step_runs AS latest
                WHERE latest.workflow_run_id = sr.workflow_run_id AND latest.step_id = sr.step_id
              )
          )
      )
  )
)) BEGIN
  SELECT RAISE(ABORT, 'Workflow final validation must match its Run and declared final output bindings');
END;
CREATE TRIGGER workflow_run_output_validations_no_update BEFORE UPDATE ON workflow_run_output_validations BEGIN
  SELECT RAISE(ABORT, 'Workflow final validations are append-only');
END;
CREATE TRIGGER workflow_run_output_validations_no_delete BEFORE DELETE ON workflow_run_output_validations BEGIN
  SELECT RAISE(ABORT, 'Workflow final validations are retained');
END;

CREATE TRIGGER workflow_runs_completion_guard BEFORE UPDATE OF state ON workflow_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND NOT EXISTS (
  SELECT 1 FROM workflow_run_output_validations AS validation
  WHERE validation.workflow_run_id = new.id
    AND validation.definition_version = new.definition_version AND validation.valid = 1
) BEGIN
  SELECT RAISE(ABORT, 'Workflow Run completion requires a valid final validation receipt');
END;
