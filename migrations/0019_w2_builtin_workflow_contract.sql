-- W2 adds immutable contract/release registries, bounded revision facts, and
-- operation receipts without rebuilding any W1 tables. Legacy W1 facts remain valid.

CREATE TABLE workflow_artifact_contract_registry (
  contract_id TEXT NOT NULL CHECK (length(trim(contract_id)) BETWEEN 1 AND 256),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
  contract_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(contract_json) AND json_type(contract_json) = 'object'
      AND length(CAST(contract_json AS BLOB)) <= 32768, 0)
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND lower(content_hash) NOT GLOB '*[^0-9a-f]*'
  ),
  registered_at TEXT NOT NULL CHECK (length(trim(registered_at)) BETWEEN 1 AND 128),
  PRIMARY KEY (contract_id, contract_version)
);
CREATE TRIGGER workflow_artifact_contract_registry_no_update
BEFORE UPDATE ON workflow_artifact_contract_registry BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact Contracts are immutable');
END;
CREATE TRIGGER workflow_artifact_contract_registry_no_delete
BEFORE DELETE ON workflow_artifact_contract_registry BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact Contracts are retained');
END;

CREATE TABLE workflow_builtin_releases (
  definition_id TEXT NOT NULL CHECK (length(trim(definition_id)) BETWEEN 1 AND 256),
  version INTEGER NOT NULL CHECK (version > 0),
  manifest_hash TEXT NOT NULL CHECK (
    length(manifest_hash) = 64 AND lower(manifest_hash) NOT GLOB '*[^0-9a-f]*'
  ),
  released_at TEXT NOT NULL CHECK (length(trim(released_at)) BETWEEN 1 AND 128),
  PRIMARY KEY (definition_id, version)
);
CREATE TRIGGER workflow_builtin_releases_no_update BEFORE UPDATE ON workflow_builtin_releases BEGIN
  SELECT RAISE(ABORT, 'Built-in Workflow releases are immutable');
END;
CREATE TRIGGER workflow_builtin_releases_no_delete BEFORE DELETE ON workflow_builtin_releases BEGIN
  SELECT RAISE(ABORT, 'Built-in Workflow releases are retained');
END;

CREATE TRIGGER workflow_versions_w2_manifest_guard BEFORE INSERT ON workflow_versions
WHEN ((json_type(new.version_json, '$.revisionGroups') IS NOT NULL
    OR json_type(new.version_json, '$.releaseMetadata') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM json_each(new.version_json, '$.steps') AS step
      WHERE json_type(step.value, '$.effectPaths') IS NOT NULL
    ))
    AND COALESCE(json_type(new.version_json, '$.contractManifest'), '') != 'array')
  OR (json_type(new.version_json, '$.contractManifest') IS NOT NULL
  AND json_type(new.version_json, '$.contractManifest') != 'array')
  OR (json_type(new.version_json, '$.contractManifest') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(new.version_json, '$.contractManifest') AS contract
    WHERE json_type(contract.value) != 'object'
      OR json_type(contract.value, '$.contractId') != 'text'
      OR json_type(contract.value, '$.contractVersion') != 'text'
      OR NOT EXISTS (
      SELECT 1 FROM workflow_artifact_contract_registry AS registry
      WHERE registry.contract_id = json_extract(contract.value, '$.contractId')
        AND registry.contract_version = json_extract(contract.value, '$.contractVersion')
        AND json(registry.contract_json) = json(contract.value)
    )
  ))
  OR json_extract(new.version_json, '$.definition.source') IS NOT (
    SELECT definition.source FROM workflow_definitions AS definition
    WHERE definition.id = new.definition_id
  )
  OR (json_extract(new.version_json, '$.definition.source') = 'BUILTIN' AND NOT EXISTS (
    SELECT 1 FROM workflow_builtin_releases AS release
    WHERE release.definition_id = new.definition_id AND release.version = new.version
      AND release.manifest_hash = json_extract(new.version_json, '$.releaseMetadata.manifestHash')
  ))
  OR (json_extract(new.version_json, '$.definition.source') != 'BUILTIN'
    AND json_type(new.version_json, '$.releaseMetadata') IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'W2 version contracts and built-in release metadata must match immutable registries');
END;

CREATE VIEW workflow_w2_operation_effect_paths AS
SELECT DISTINCT sr.workflow_run_id, sr.id AS step_run_id,
  json_extract(step.value, '$.effectType') AS effect_type, path.value AS relative_path
FROM workflow_step_runs AS sr
JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
JOIN workflow_versions AS version ON version.definition_id = run.definition_id
  AND version.version = run.definition_version
JOIN json_each(version.version_json, '$.steps') AS step
  ON json_extract(step.value, '$.id') = sr.step_id
JOIN json_each(step.value, '$.effectPaths') AS path
WHERE json_type(version.version_json, '$.contractManifest') = 'array'
  AND json_type(step.value, '$.effectPaths') = 'array'
  AND json_extract(step.value, '$.effectType') IN ('FILE_OUTPUT', 'WORKSPACE_MUTATION')
  AND path.type = 'text';

CREATE TABLE workflow_revision_traversals (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  edge_id TEXT NOT NULL CHECK (length(trim(edge_id)) BETWEEN 1 AND 256),
  group_id TEXT NOT NULL CHECK (length(trim(group_id)) BETWEEN 1 AND 256),
  traversal_index INTEGER NOT NULL CHECK (traversal_index BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (step_run_id),
  UNIQUE (workflow_run_id, group_id, traversal_index),
  FOREIGN KEY (step_run_id, workflow_run_id)
    REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_revision_traversals_timeline_idx
  ON workflow_revision_traversals(workflow_run_id, created_at, id);
CREATE TRIGGER workflow_revision_traversals_validate_insert BEFORE INSERT ON workflow_revision_traversals
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_step_runs AS sr
  JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
  JOIN workflow_versions AS version ON version.definition_id = run.definition_id
    AND version.version = run.definition_version
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.state = 'RUNNING'
    AND json_type(version.version_json, '$.contractManifest') = 'array'
    AND EXISTS (
      SELECT 1 FROM workflow_decisions AS decision
      JOIN json_each(version.version_json, '$.edges') AS selected_edge
        ON json_extract(selected_edge.value, '$.id') = decision.edge_id
      WHERE decision.workflow_run_id = new.workflow_run_id
        AND decision.step_run_id = new.step_run_id AND decision.edge_id = new.edge_id
        AND decision.branch = json_extract(selected_edge.value, '$.branch')
    )
    AND EXISTS (
      SELECT 1 FROM json_each(version.version_json, '$.edges') AS edge
      WHERE json_extract(edge.value, '$.id') = new.edge_id
        AND json_extract(edge.value, '$.revision.groupId') = new.group_id
        AND json_extract(edge.value, '$.revision.maxTraversals') > 0
        AND new.traversal_index = (
          SELECT COUNT(*) + 1 FROM workflow_revision_traversals AS prior
          WHERE prior.workflow_run_id = new.workflow_run_id AND prior.group_id = new.group_id
        )
        AND (
          SELECT COUNT(*) FROM workflow_revision_traversals AS prior
          WHERE prior.workflow_run_id = new.workflow_run_id AND prior.edge_id = new.edge_id
        ) < json_extract(edge.value, '$.revision.maxTraversals')
    )
    AND EXISTS (
      SELECT 1 FROM json_each(version.version_json, '$.revisionGroups') AS revision_group
      WHERE json_extract(revision_group.value, '$.id') = new.group_id
        AND json_extract(revision_group.value, '$.maxTotalTraversals') > 0
        AND new.traversal_index = (
          SELECT COUNT(*) + 1 FROM workflow_revision_traversals AS prior
          WHERE prior.workflow_run_id = new.workflow_run_id AND prior.group_id = new.group_id
        )
        AND (
          SELECT COUNT(*) FROM workflow_revision_traversals AS prior
          WHERE prior.workflow_run_id = new.workflow_run_id AND prior.group_id = new.group_id
        ) < json_extract(revision_group.value, '$.maxTotalTraversals')
    )
) BEGIN
  SELECT RAISE(ABORT, 'Workflow revision traversal must match a committed declared decision within edge and group budgets');
END;
CREATE TRIGGER workflow_revision_traversals_no_update BEFORE UPDATE ON workflow_revision_traversals BEGIN
  SELECT RAISE(ABORT, 'Workflow revision traversals are append-only');
END;
CREATE TRIGGER workflow_revision_traversals_no_delete BEFORE DELETE ON workflow_revision_traversals BEGIN
  SELECT RAISE(ABORT, 'Workflow revision traversals are retained');
END;

CREATE TABLE workflow_step_operation_receipts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) BETWEEN 1 AND 256),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('NONE', 'FILE_OUTPUT', 'WORKSPACE_MUTATION', 'EXTERNAL_ACTION')),
  state TEXT NOT NULL CHECK (state IN ('PREPARED', 'APPLIED', 'VERIFIED', 'UNKNOWN')),
  input_hash TEXT NOT NULL CHECK (
    length(input_hash) = 64 AND lower(input_hash) NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT CHECK (
    manifest_json IS NULL OR COALESCE(json_valid(manifest_json)
      AND json_type(manifest_json) = 'array' AND json_array_length(manifest_json) <= 32
      AND length(CAST(manifest_json AS BLOB)) <= 32768, 0)
  ),
  output_artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    COALESCE(json_valid(output_artifact_ids_json)
      AND json_type(output_artifact_ids_json) = 'array'
      AND json_array_length(output_artifact_ids_json) <= 12
      AND length(CAST(output_artifact_ids_json AS BLOB)) <= 4096, 0)
  ),
  external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) <= 2048),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  UNIQUE (workflow_run_id, step_run_id, attempt, operation_key),
  FOREIGN KEY (step_run_id, workflow_run_id)
    REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_step_operation_receipts_run_idx
  ON workflow_step_operation_receipts(workflow_run_id, created_at, id);
CREATE TRIGGER workflow_step_operation_receipts_manifest_validate_insert
BEFORE INSERT ON workflow_step_operation_receipts
WHEN (new.effect_type IN ('NONE', 'EXTERNAL_ACTION')
    AND COALESCE(json_array_length(new.manifest_json), 0) != 0)
  OR (new.effect_type IN ('FILE_OUTPUT', 'WORKSPACE_MUTATION') AND (
    new.manifest_json IS NULL
    OR COALESCE(json_array_length(new.manifest_json), 0) = 0
    OR json_array_length(new.manifest_json) != (
      SELECT COUNT(*) FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
    )
    OR EXISTS (
      SELECT 1 FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
        AND NOT EXISTS (
          SELECT 1 FROM json_each(new.manifest_json) AS entry
          WHERE json_extract(entry.value, '$.relativePath') = declared.relative_path
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
    )
    OR EXISTS (
      SELECT 1 FROM json_each(new.manifest_json) AS entry
      WHERE json_type(entry.value) != 'object'
        OR json_type(entry.value, '$.relativePath') != 'text'
        OR json_type(entry.value, '$.afterHash') IS NOT NULL
        OR (json_type(entry.value, '$.beforeHash') IS NOT NULL AND (
          json_type(entry.value, '$.beforeHash') != 'text'
          OR length(json_extract(entry.value, '$.beforeHash')) != 64
          OR lower(json_extract(entry.value, '$.beforeHash')) GLOB '*[^0-9a-f]*'
        ))
        OR EXISTS (
          SELECT 1 FROM json_each(entry.value) AS field
          WHERE field.key NOT IN ('relativePath', 'beforeHash')
        )
    )
  )) BEGIN
  SELECT RAISE(ABORT, 'W2 PREPARED operation manifest must capture only the exact declared before state');
END;
CREATE TRIGGER workflow_step_operation_receipts_manifest_validate_update
BEFORE UPDATE ON workflow_step_operation_receipts
WHEN (new.effect_type IN ('NONE', 'EXTERNAL_ACTION')
    AND COALESCE(json_array_length(new.manifest_json), 0) != 0)
  OR (new.effect_type IN ('FILE_OUTPUT', 'WORKSPACE_MUTATION') AND (
    new.manifest_json IS NULL
    OR COALESCE(json_array_length(new.manifest_json), 0) = 0
    OR json_array_length(new.manifest_json) != (
      SELECT COUNT(*) FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
    )
    OR EXISTS (
      SELECT 1 FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
        AND NOT EXISTS (
          SELECT 1 FROM json_each(new.manifest_json) AS entry
          WHERE json_extract(entry.value, '$.relativePath') = declared.relative_path
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM workflow_w2_operation_effect_paths AS declared
      WHERE declared.step_run_id = new.step_run_id AND declared.effect_type = new.effect_type
    )
    OR EXISTS (
      SELECT 1 FROM json_each(new.manifest_json) AS entry
      WHERE json_type(entry.value) != 'object'
        OR json_type(entry.value, '$.relativePath') != 'text'
        OR (json_type(entry.value, '$.beforeHash') IS NOT NULL AND (
          json_type(entry.value, '$.beforeHash') != 'text'
          OR length(json_extract(entry.value, '$.beforeHash')) != 64
          OR lower(json_extract(entry.value, '$.beforeHash')) GLOB '*[^0-9a-f]*'
        ))
        OR (new.state IN ('APPLIED', 'VERIFIED') AND (
          COALESCE(json_type(entry.value, '$.afterHash'), '') != 'text'
          OR length(json_extract(entry.value, '$.afterHash')) != 64
          OR lower(json_extract(entry.value, '$.afterHash')) GLOB '*[^0-9a-f]*'
        ))
        OR (new.state = 'PREPARED' AND json_type(entry.value, '$.afterHash') IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM json_each(entry.value) AS field
          WHERE field.key NOT IN ('relativePath', 'beforeHash', 'afterHash')
        )
    )
  )) BEGIN
  SELECT RAISE(ABORT, 'W2 operation manifest must match its declared paths and persisted state evidence');
END;
CREATE TRIGGER workflow_step_operation_receipts_validate_insert BEFORE INSERT ON workflow_step_operation_receipts
WHEN new.state != 'PREPARED'
  OR json_array_length(new.output_artifact_ids_json) != 0
  OR new.external_reference IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM workflow_step_runs AS sr
    JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
    JOIN workflow_versions AS version ON version.definition_id = run.definition_id
      AND version.version = run.definition_version
    JOIN workflow_steps AS step ON step.definition_id = run.definition_id
      AND step.version = run.definition_version AND step.id = sr.step_id
    WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
      AND sr.attempt = new.attempt AND sr.state = 'RUNNING'
      AND step.type != 'DECISION' AND step.effect_type = new.effect_type
      AND json_type(version.version_json, '$.contractManifest') = 'array'
  ) BEGIN
  SELECT RAISE(ABORT, 'W2 operation must start PREPARED for its running non-Decision StepRun');
END;
CREATE TRIGGER workflow_step_operation_receipts_identity_immutable BEFORE UPDATE ON workflow_step_operation_receipts
WHEN new.id IS NOT old.id OR new.workflow_run_id IS NOT old.workflow_run_id
  OR new.step_run_id IS NOT old.step_run_id OR new.attempt IS NOT old.attempt
  OR new.operation_key IS NOT old.operation_key OR new.effect_type IS NOT old.effect_type
  OR new.input_hash IS NOT old.input_hash OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'Workflow operation receipt ownership and inputs are immutable');
END;
CREATE TRIGGER workflow_step_operation_receipts_transition BEFORE UPDATE ON workflow_step_operation_receipts
WHEN (new.state IS old.state AND (
    new.manifest_json IS NOT old.manifest_json
    OR new.output_artifact_ids_json IS NOT old.output_artifact_ids_json
    OR new.external_reference IS NOT old.external_reference
    OR new.updated_at IS NOT old.updated_at
  )) OR (new.state IS NOT old.state AND NOT (
    (old.state = 'PREPARED' AND new.state IN ('APPLIED', 'UNKNOWN')) OR
    (old.state = 'APPLIED' AND new.state IN ('VERIFIED', 'UNKNOWN'))
  )) OR (new.state IN ('APPLIED', 'VERIFIED') AND (
    (new.effect_type = 'EXTERNAL_ACTION' AND (
      new.external_reference IS NULL OR NOT EXISTS (
        SELECT 1 FROM workflow_step_runs AS sr
        JOIN external_work_requests AS request
          ON request.mission_id = sr.mission_id AND request.run_id = sr.mission_run_id
        WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
          AND request.state = 'ACCEPTED'
          AND EXISTS (
            SELECT 1 FROM external_work_artifacts AS accepted_artifact
            WHERE accepted_artifact.external_work_request_id = request.id
              AND accepted_artifact.submitted_at = request.submitted_at
          )
          AND (
            request.id = new.external_reference OR EXISTS (
              SELECT 1 FROM external_work_artifacts AS accepted_artifact
              WHERE accepted_artifact.id = new.external_reference
                AND accepted_artifact.external_work_request_id = request.id
                AND accepted_artifact.submitted_at = request.submitted_at
            )
          )
      )
    ))
  )) OR (new.state = 'VERIFIED' AND EXISTS (
    SELECT 1 FROM json_each(new.output_artifact_ids_json) AS output
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_artifacts AS artifact
      JOIN workflow_validation_receipts AS receipt
        ON receipt.workflow_run_id = artifact.workflow_run_id
          AND receipt.step_run_id = artifact.producer_step_run_id
          AND receipt.artifact_id = artifact.id
          AND receipt.content_hash = artifact.content_hash AND receipt.valid = 1
      JOIN workflow_runs AS run ON run.id = artifact.workflow_run_id
      JOIN workflow_versions AS version ON version.definition_id = run.definition_id
        AND version.version = run.definition_version
      WHERE artifact.id = output.value AND artifact.workflow_run_id = new.workflow_run_id
        AND artifact.producer_step_run_id = new.step_run_id
        AND receipt.workflow_run_id = new.workflow_run_id
        AND receipt.step_run_id = new.step_run_id
        AND EXISTS (
          SELECT 1 FROM json_each(version.version_json, '$.steps') AS frozen_step
          JOIN json_each(frozen_step.value, '$.outputs') AS spec
          WHERE json_extract(frozen_step.value, '$.id') = (
              SELECT step_id FROM workflow_step_runs WHERE id = new.step_run_id
            )
            AND json_extract(spec.value, '$.kind') = artifact.kind
            AND json_extract(spec.value, '$.contractId') = receipt.contract_id
            AND json_extract(spec.value, '$.contractVersion') = receipt.contract_version
            AND (json_type(artifact.metadata_json, '$.outputKey') IS NULL
              OR json_extract(spec.value, '$.key') = json_extract(artifact.metadata_json, '$.outputKey'))
            AND (json_extract(spec.value, '$.validator.type') != 'REGISTRY' OR EXISTS (
              SELECT 1 FROM json_each(version.version_json, '$.contractManifest') AS contract
              WHERE json_extract(contract.value, '$.contractId') = receipt.contract_id
                AND json_extract(contract.value, '$.contractVersion') = receipt.contract_version
            ))
        )
    )
  )) OR (new.state = 'APPLIED' AND json_array_length(new.output_artifact_ids_json) != 0)
  OR (new.state = 'VERIFIED' AND new.effect_type = 'FILE_OUTPUT'
    AND json_array_length(new.output_artifact_ids_json) = 0)
  OR (old.state = 'PREPARED' AND new.state = 'APPLIED'
    AND new.effect_type IN ('FILE_OUTPUT', 'WORKSPACE_MUTATION') AND EXISTS (
      SELECT 1 FROM json_each(old.manifest_json) AS before_entry
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(new.manifest_json) AS applied_entry
        WHERE json_extract(applied_entry.value, '$.relativePath')
            = json_extract(before_entry.value, '$.relativePath')
          AND json_extract(applied_entry.value, '$.beforeHash')
            IS json_extract(before_entry.value, '$.beforeHash')
      )
    ))
  OR (old.state = 'APPLIED' AND new.state = 'VERIFIED' AND (
    new.manifest_json IS NOT old.manifest_json
    OR new.external_reference IS NOT old.external_reference
    OR EXISTS (
      SELECT 1 FROM json_each(old.output_artifact_ids_json) AS old_output
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(new.output_artifact_ids_json) AS new_output
        WHERE new_output.value = old_output.value
      )
    )
  ))
  OR (new.state = 'UNKNOWN' AND (
    new.manifest_json IS NOT old.manifest_json
    OR new.output_artifact_ids_json IS NOT old.output_artifact_ids_json
    OR new.external_reference IS NOT old.external_reference
  ))
  OR (new.state = 'VERIFIED' AND json_array_length(new.output_artifact_ids_json) !=
      (SELECT COUNT(DISTINCT item.value) FROM json_each(new.output_artifact_ids_json) AS item))
BEGIN
  SELECT RAISE(ABORT, 'Workflow operation receipt transition, evidence, or validation is invalid');
END;
CREATE TRIGGER workflow_step_operation_receipts_no_delete BEFORE DELETE ON workflow_step_operation_receipts BEGIN
  SELECT RAISE(ABORT, 'Workflow operation receipts are retained');
END;

CREATE TABLE workflow_step_operation_audit (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES workflow_step_operation_receipts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'APPLIED', 'VERIFIED', 'UNKNOWN')),
  receipt_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(receipt_json) AND json_type(receipt_json) = 'object'
      AND length(CAST(receipt_json AS BLOB)) <= 65536, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128)
);
CREATE INDEX workflow_step_operation_audit_timeline_idx
  ON workflow_step_operation_audit(operation_id, event_id);
CREATE TRIGGER workflow_step_operation_audit_insert AFTER INSERT ON workflow_step_operation_receipts BEGIN
  INSERT INTO workflow_step_operation_audit (operation_id, event_type, receipt_json, created_at)
  VALUES (new.id, new.state,
    json_object(
      'id', new.id, 'workflowRunId', new.workflow_run_id, 'stepRunId', new.step_run_id,
      'attempt', new.attempt, 'operationKey', new.operation_key, 'effectType', new.effect_type,
      'state', new.state, 'inputHash', new.input_hash,
      'manifest', json(new.manifest_json), 'outputArtifactIds', json(new.output_artifact_ids_json),
      'externalReference', new.external_reference,
      'createdAt', new.created_at, 'updatedAt', new.updated_at
    ), new.created_at);
END;
CREATE TRIGGER workflow_step_operation_audit_update AFTER UPDATE OF state ON workflow_step_operation_receipts
WHEN new.state IS NOT old.state BEGIN
  INSERT INTO workflow_step_operation_audit (operation_id, event_type, receipt_json, created_at)
  VALUES (new.id, new.state,
    json_object(
      'id', new.id, 'workflowRunId', new.workflow_run_id, 'stepRunId', new.step_run_id,
      'attempt', new.attempt, 'operationKey', new.operation_key, 'effectType', new.effect_type,
      'state', new.state, 'inputHash', new.input_hash,
      'manifest', json(new.manifest_json), 'outputArtifactIds', json(new.output_artifact_ids_json),
      'externalReference', new.external_reference,
      'createdAt', new.created_at, 'updatedAt', new.updated_at
    ), new.updated_at);
END;
CREATE TRIGGER workflow_step_operation_audit_no_update BEFORE UPDATE ON workflow_step_operation_audit BEGIN
  SELECT RAISE(ABORT, 'Workflow operation audit snapshots are append-only');
END;
CREATE TRIGGER workflow_step_operation_audit_no_delete BEFORE DELETE ON workflow_step_operation_audit BEGIN
  SELECT RAISE(ABORT, 'Workflow operation audit snapshots are retained');
END;

CREATE TRIGGER workflow_step_runs_w2_completion_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED'
  AND EXISTS (
    SELECT 1 FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.definition_id = run.definition_id
      AND version.version = run.definition_version
    JOIN workflow_steps AS step ON step.definition_id = run.definition_id
      AND step.version = run.definition_version AND step.id = new.step_id
    WHERE run.id = new.workflow_run_id
      AND json_type(version.version_json, '$.contractManifest') = 'array'
      AND step.type != 'DECISION'
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM workflow_step_operation_receipts AS receipt
      WHERE receipt.workflow_run_id = new.workflow_run_id
        AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt
        AND receipt.effect_type = (
          SELECT step.effect_type FROM workflow_runs AS run
          JOIN workflow_steps AS step ON step.definition_id = run.definition_id
            AND step.version = run.definition_version AND step.id = new.step_id
          WHERE run.id = new.workflow_run_id
        ) AND receipt.state = 'VERIFIED'
    )
    OR EXISTS (
      SELECT 1 FROM workflow_step_operation_receipts AS receipt
      WHERE receipt.workflow_run_id = new.workflow_run_id
        AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt
        AND receipt.state != 'VERIFIED'
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'W2 Workflow StepRun completion requires verified operation receipts');
END;
-- W2 canonical filesystem results retain W1 provenance checks for all legacy facts.
DROP TRIGGER workflow_artifacts_validate_insert;
CREATE TRIGGER workflow_artifacts_validate_insert BEFORE INSERT ON workflow_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  WHERE sr.id = new.producer_step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.state = 'RUNNING' AND sr.mission_id = new.mission_id AND sr.mission_run_id = new.mission_run_id
) OR NOT (
  (new.source = 'MISSION' AND new.kind IN ('FILE','DIRECTORY') AND EXISTS (
  SELECT 1 FROM workflow_step_operation_receipts AS operation
  JOIN workflow_step_runs AS sr ON sr.id = operation.step_run_id
  JOIN mission_runs AS mr ON mr.id = sr.mission_run_id AND mr.mission_id = sr.mission_id
  JOIN missions AS m ON m.id = mr.mission_id
  WHERE operation.workflow_run_id = new.workflow_run_id
    AND sr.id = new.producer_step_run_id AND operation.attempt = sr.attempt
    AND operation.state IN ('APPLIED','VERIFIED')
    AND mr.id = new.mission_run_id AND m.id = new.mission_id
    AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED'
    AND ((new.kind = 'FILE' AND new.content = '' AND EXISTS (
      SELECT 1 FROM json_each(operation.manifest_json) AS item
      JOIN mission_events AS event ON event.id = new.source_id
      WHERE json_extract(item.value,'$.relativePath') = json_extract(new.metadata_json,'$.path')
        AND json_extract(item.value,'$.afterHash') = json_extract(new.metadata_json,'$.contentHash')
        AND json_extract(new.metadata_json,'$.evidenceEventId') = event.id
        AND event.mission_id = m.id AND event.run_id = mr.id AND event.actor_id = new.actor_id
        AND event.event_type = 'tool.result'
        AND json_extract(event.payload_json,'$.success') = 1
        AND json_extract(event.payload_json,'$.capability') = 'FILE_WRITE'
        AND json_extract(event.payload_json,'$.resource') = json_extract(new.metadata_json,'$.permissionResource')
        AND json_extract(new.metadata_json,'$.permissionResource') = 'file:' || json_extract(new.metadata_json,'$.workspaceTag') || ':' || lower(replace(json_extract(item.value,'$.relativePath'),char(92),'/'))
        AND substr(json_extract(event.payload_json,'$.resource'),-length(json_extract(item.value,'$.relativePath')))
          = lower(replace(json_extract(item.value,'$.relativePath'),char(92),'/'))
    )) OR (new.kind = 'DIRECTORY' AND new.source_id = mr.id
      AND new.actor_id = m.coordinator_teammate_id
      AND json_extract(new.metadata_json,'$.inspectedManifest') = 1
      AND json_valid(json_extract(new.metadata_json,'$.executionEvidence'))
      AND json_valid(new.content) AND json_type(new.content,'$.entries') = 'array'
      AND json_array_length(new.content,'$.entries') = json_array_length(operation.manifest_json)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.content,'$.entries') AS output
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(operation.manifest_json) AS item
          WHERE json_extract(item.value,'$.relativePath') = json_extract(output.value,'$.relativePath')
            AND json_extract(item.value,'$.afterHash') = coalesce(json_extract(output.value,'$.afterHash'),json_extract(output.value,'$.contentHash'))
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(new.metadata_json,'$.executionEvidence')) AS evidence
              WHERE json_extract(evidence.value,'$.relativePath') = json_extract(item.value,'$.relativePath')
                AND ((json_extract(evidence.value,'$.source') = 'MISSION' AND EXISTS (
                  SELECT 1 FROM mission_events AS event
                  WHERE event.id = json_extract(evidence.value,'$.sourceId')
                    AND event.mission_id = m.id AND event.run_id = mr.id
                    AND event.actor_id = json_extract(evidence.value,'$.actorId')
                    AND event.event_type = 'tool.result'
                    AND json_extract(event.payload_json,'$.success') = 1
                    AND json_extract(event.payload_json,'$.capability') = 'FILE_WRITE'
                    AND json_extract(event.payload_json,'$.resource') = 'file:' || json_extract(new.metadata_json,'$.workspaceTag') || ':' || lower(replace(json_extract(item.value,'$.relativePath'),char(92),'/'))
                )) OR (json_extract(evidence.value,'$.source') = 'HUMAN_BRIDGE' AND EXISTS (
                  SELECT 1 FROM external_work_artifacts AS ext
                  JOIN external_work_requests AS req ON req.id = ext.external_work_request_id
                  WHERE ext.id = json_extract(evidence.value,'$.sourceId')
                    AND req.state = 'ACCEPTED' AND ext.submitted_at = req.submitted_at
                    AND req.mission_id = m.id AND req.run_id = mr.id
                    AND req.assignee_teammate_id = json_extract(evidence.value,'$.actorId')
                    AND ext.path = json_extract(item.value,'$.relativePath')
                )))
            )
        )
      )
    ))
)) OR (new.source = 'MISSION' AND EXISTS (
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
