-- W2.2: durable, path-specific workspace mutation and verification facts.
-- Dynamic effects remain gated by a trusted OFFICIAL software Workflow and the
-- existing ToolRuntime / PermissionEngine path.

CREATE TABLE workflow_workspace_mutation_journal (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  operation_receipt_id TEXT NOT NULL REFERENCES workflow_step_operation_receipts(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  tool_call_id TEXT NOT NULL CHECK (length(trim(tool_call_id)) BETWEEN 1 AND 256),
  tool_id TEXT NOT NULL CHECK (tool_id = 'file.writeText'),
  permission_resource TEXT NOT NULL CHECK (length(permission_resource) BETWEEN 1 AND 1536),
  workspace_tag TEXT NOT NULL CHECK (
    length(workspace_tag) = 16 AND lower(workspace_tag) NOT GLOB '*[^0-9a-f]*'
  ),
  relative_path TEXT NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 1024
    AND substr(relative_path, 1, 1) != '/'
    AND instr(relative_path, char(92)) = 0
    AND instr(relative_path, char(0)) = 0
    AND relative_path NOT LIKE '%//%'
    AND relative_path NOT LIKE './%'
    AND relative_path NOT LIKE '%/./%'
    AND relative_path NOT LIKE '%/.'
    AND relative_path NOT LIKE '../%'
    AND relative_path NOT LIKE '%/../%'
    AND relative_path NOT LIKE '%/..'
    AND relative_path NOT GLOB '[A-Za-z]:*'
    AND relative_path NOT LIKE '%:%'
  ),
  before_hash TEXT CHECK (
    before_hash IS NULL OR (length(before_hash) = 64 AND lower(before_hash) NOT GLOB '*[^0-9a-f]*')
  ),
  expected_after_hash TEXT NOT NULL CHECK (
    length(expected_after_hash) = 64 AND lower(expected_after_hash) NOT GLOB '*[^0-9a-f]*'
  ),
  observed_after_hash TEXT CHECK (
    observed_after_hash IS NULL OR (length(observed_after_hash) = 64 AND lower(observed_after_hash) NOT GLOB '*[^0-9a-f]*')
  ),
  state TEXT NOT NULL CHECK (state IN ('PREPARED', 'APPLIED', 'UNKNOWN')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  UNIQUE (workflow_run_id, step_run_id, attempt, tool_call_id),
  FOREIGN KEY (step_run_id, workflow_run_id)
    REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT,
  CHECK (
    permission_resource = 'file:' || workspace_tag || ':' || lower(relative_path)
  ),
  CHECK (
    (state = 'PREPARED' AND observed_after_hash IS NULL AND result_code IS NULL)
    OR (state = 'APPLIED' AND observed_after_hash = expected_after_hash AND result_code IS NOT NULL)
    OR (state = 'UNKNOWN' AND result_code IS NOT NULL)
  )
);
CREATE INDEX workflow_workspace_mutation_journal_run_idx
  ON workflow_workspace_mutation_journal(workflow_run_id, created_at, id);
CREATE INDEX workflow_workspace_mutation_journal_operation_idx
  ON workflow_workspace_mutation_journal(operation_receipt_id, relative_path, created_at, id);
CREATE INDEX workflow_workspace_mutation_journal_mission_run_idx
  ON workflow_workspace_mutation_journal(mission_run_id, step_run_id, state);

CREATE TRIGGER workflow_versions_software_dynamic_effect_guard
BEFORE INSERT ON workflow_versions
WHEN EXISTS (
  SELECT 1 FROM json_each(new.version_json, '$.steps') AS step
  WHERE json_type(step.value, '$.effectPathMode') = 'text'
    AND json_extract(step.value, '$.effectPathMode') = 'DYNAMIC'
    AND (
      json_extract(new.version_json, '$.definition.source') != 'BUILTIN'
      OR json_extract(new.version_json, '$.validationPolicy') != 'software-integrity-v1'
      OR json_extract(step.value, '$.effectType') != 'WORKSPACE_MUTATION'
      OR (json_type(step.value, '$.effectPaths') IS NOT NULL
        AND (json_type(step.value, '$.effectPaths') != 'array'
          OR json_array_length(step.value, '$.effectPaths') != 0))
    )
) BEGIN
  SELECT RAISE(ABORT, 'Dynamic Workspace effects require an OFFICIAL software Workflow with no fixed paths');
END;

CREATE TRIGGER workflow_workspace_mutation_journal_validate_insert
BEFORE INSERT ON workflow_workspace_mutation_journal
WHEN new.state != 'PREPARED'
  OR new.observed_after_hash IS NOT NULL
  OR new.result_code IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM workflow_step_runs AS sr
    JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
    JOIN workflow_versions AS version ON version.definition_id = run.definition_id
      AND version.version = run.definition_version
    JOIN json_each(version.version_json, '$.steps') AS step
      ON json_extract(step.value, '$.id') = sr.step_id
    JOIN workflow_step_operation_receipts AS operation ON operation.id = new.operation_receipt_id
    JOIN mission_runs AS mr ON mr.id = new.mission_run_id
    JOIN missions AS mission ON mission.id = mr.mission_id
    LEFT JOIN mission_participants AS participant ON participant.mission_id = mission.id
      AND participant.teammate_id = new.teammate_id
    WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
      AND sr.attempt = new.attempt AND sr.state IN ('RUNNING', 'WAITING')
      AND sr.mission_id = new.mission_id AND sr.mission_run_id = new.mission_run_id
      AND mr.mission_id = new.mission_id AND mr.status = 'RUNNING'
      AND operation.workflow_run_id = new.workflow_run_id AND operation.step_run_id = sr.id
      AND operation.attempt = sr.attempt AND operation.state = 'PREPARED'
      AND operation.effect_type = 'WORKSPACE_MUTATION'
      AND json_extract(step.value, '$.effectType') = 'WORKSPACE_MUTATION'
      AND json_extract(step.value, '$.effectPathMode') = 'DYNAMIC'
      AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
      AND json_extract(version.version_json, '$.validationPolicy') = 'software-integrity-v1'
      AND (mission.coordinator_teammate_id = new.teammate_id OR participant.teammate_id = new.teammate_id)
  ) BEGIN
  SELECT RAISE(ABORT, 'Workspace mutation intent must bind a running, permission-gated software Step');
END;

CREATE TRIGGER workflow_workspace_mutation_journal_identity_immutable
BEFORE UPDATE ON workflow_workspace_mutation_journal
WHEN new.id IS NOT old.id OR new.workflow_run_id IS NOT old.workflow_run_id
  OR new.step_run_id IS NOT old.step_run_id OR new.operation_receipt_id IS NOT old.operation_receipt_id
  OR new.attempt IS NOT old.attempt OR new.mission_id IS NOT old.mission_id
  OR new.mission_run_id IS NOT old.mission_run_id OR new.teammate_id IS NOT old.teammate_id
  OR new.tool_call_id IS NOT old.tool_call_id OR new.tool_id IS NOT old.tool_id
  OR new.permission_resource IS NOT old.permission_resource OR new.workspace_tag IS NOT old.workspace_tag
  OR new.relative_path IS NOT old.relative_path OR new.before_hash IS NOT old.before_hash
  OR new.expected_after_hash IS NOT old.expected_after_hash OR new.created_at IS NOT old.created_at
  OR (old.state = 'PREPARED' AND new.state NOT IN ('APPLIED', 'UNKNOWN'))
  OR (old.state != 'PREPARED' AND new.state IS NOT old.state)
  OR (new.state = 'APPLIED' AND new.observed_after_hash IS NOT new.expected_after_hash)
  OR (new.state = 'UNKNOWN' AND new.result_code IS NULL)
  OR (old.state = 'PREPARED' AND new.state = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM workflow_step_runs AS sr
    JOIN mission_runs AS mr ON mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
    WHERE sr.id = new.step_run_id AND sr.mission_run_id = mr.id
      AND sr.state IN ('RUNNING', 'WAITING') AND mr.status = 'RUNNING'
  )) BEGIN
  SELECT RAISE(ABORT, 'Workspace mutation intent allows one immutable PREPARED-to-terminal transition');
END;
CREATE TRIGGER workflow_workspace_mutation_journal_no_delete
BEFORE DELETE ON workflow_workspace_mutation_journal BEGIN
  SELECT RAISE(ABORT, 'Workspace mutation journal facts are retained');
END;

CREATE TABLE workflow_verification_facts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 256),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  tool_call_id TEXT NOT NULL CHECK (length(trim(tool_call_id)) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL CHECK (length(trim(command_id)) BETWEEN 1 AND 128),
  tool_id TEXT NOT NULL CHECK (length(trim(tool_id)) BETWEEN 1 AND 128),
  command TEXT NOT NULL CHECK (length(trim(command)) BETWEEN 1 AND 512),
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64 AND lower(command_hash) NOT GLOB '*[^0-9a-f]*'),
  exit_status INTEGER NOT NULL CHECK (exit_status BETWEEN -1 AND 255),
  criterion_ids_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(criterion_ids_json) AND json_type(criterion_ids_json) = 'array'
      AND json_array_length(criterion_ids_json) BETWEEN 1 AND 32
      AND length(CAST(criterion_ids_json AS BLOB)) <= 4096, 0)
  ),
  output_hash TEXT NOT NULL CHECK (length(output_hash) = 64 AND lower(output_hash) NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  UNIQUE (workflow_run_id, step_run_id, attempt, tool_call_id),
  FOREIGN KEY (step_run_id, workflow_run_id)
    REFERENCES workflow_step_runs(id, workflow_run_id) ON DELETE RESTRICT
);
CREATE INDEX workflow_verification_facts_run_idx
  ON workflow_verification_facts(workflow_run_id, step_run_id, created_at, id);
CREATE INDEX workflow_verification_facts_command_idx
  ON workflow_verification_facts(workflow_run_id, command_id, exit_status);

CREATE TRIGGER workflow_verification_facts_validate_insert
BEFORE INSERT ON workflow_verification_facts
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_step_runs AS sr
  JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
  JOIN workflow_versions AS version ON version.definition_id = run.definition_id
    AND version.version = run.definition_version
  JOIN mission_runs AS mr ON mr.id = new.mission_run_id
  JOIN missions AS mission ON mission.id = mr.mission_id
  LEFT JOIN mission_participants AS participant ON participant.mission_id = mission.id
    AND participant.teammate_id = new.actor_id
  JOIN workflow_artifact_bindings AS plan_binding ON plan_binding.workflow_run_id = run.id
    AND plan_binding.role = 'OUTPUT' AND plan_binding.key = 'software.plan_scope'
  JOIN workflow_artifacts AS plan ON plan.id = plan_binding.artifact_id AND plan.kind = 'JSON'
  JOIN workflow_step_runs AS plan_step ON plan_step.id = plan.producer_step_run_id
    AND plan_step.workflow_run_id = run.id AND plan_step.state = 'COMPLETED'
  JOIN json_each(plan.content, '$.commands') AS plan_command
    ON json_extract(plan_command.value, '$.id') = new.command_id
    AND json_extract(plan_command.value, '$.command') = new.command
  JOIN workflow_artifact_bindings AS acceptance_binding ON acceptance_binding.workflow_run_id = run.id
    AND acceptance_binding.role = 'OUTPUT' AND acceptance_binding.key = 'software.acceptance'
  JOIN workflow_artifacts AS acceptance ON acceptance.id = acceptance_binding.artifact_id
    AND acceptance.kind = 'JSON'
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.attempt = new.attempt AND sr.step_id = 'S06' AND sr.state IN ('RUNNING', 'WAITING')
    AND sr.mission_id = new.mission_id AND sr.mission_run_id = new.mission_run_id
    AND mr.mission_id = new.mission_id AND mr.status = 'RUNNING'
    AND mission.id = new.mission_id
    AND (mission.coordinator_teammate_id = new.actor_id OR participant.teammate_id = new.actor_id)
    AND EXISTS (
      SELECT 1 FROM mission_events AS event
      WHERE event.mission_id = new.mission_id AND event.run_id = new.mission_run_id
        AND event.actor_type = 'TEAMMATE' AND event.actor_id = new.actor_id
        AND event.event_type = 'model.call_started'
    )
    AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
    AND json_extract(version.version_json, '$.validationPolicy') = 'software-integrity-v1'
    AND json_type(acceptance.content, '$.criteria') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(new.criterion_ids_json) AS criterion
      WHERE criterion.type != 'text'
        OR NOT EXISTS (
          SELECT 1 FROM json_each(plan_command.value, '$.acceptanceCriteriaIds') AS allowed
          JOIN json_each(acceptance.content, '$.criteria') AS declared
            ON json_extract(declared.value, '$.id') = allowed.value
          WHERE allowed.value = criterion.value
        )
    )
) BEGIN
  SELECT RAISE(ABORT, 'Verification fact must match the current software S06 Plan command and acceptance criteria');
END;
CREATE TRIGGER workflow_verification_facts_no_update
BEFORE UPDATE ON workflow_verification_facts BEGIN
  SELECT RAISE(ABORT, 'Workflow verification facts are append-only');
END;
CREATE TRIGGER workflow_verification_facts_no_delete
BEFORE DELETE ON workflow_verification_facts BEGIN
  SELECT RAISE(ABORT, 'Workflow verification facts are retained');
END;


-- W2.0 receipt path validation remains exact for frozen fixed-path effects.
DROP TRIGGER workflow_step_operation_receipts_manifest_validate_insert;
DROP TRIGGER workflow_step_operation_receipts_manifest_validate_update;
CREATE TRIGGER workflow_step_operation_receipts_manifest_validate_insert
BEFORE INSERT ON workflow_step_operation_receipts
WHEN ((new.effect_type IN ('NONE', 'EXTERNAL_ACTION')
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
  ))) AND NOT (new.effect_type = 'WORKSPACE_MUTATION'
  AND json_array_length(new.manifest_json) = 0
  AND EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
  JOIN workflow_versions AS version ON version.definition_id = run.definition_id
    AND version.version = run.definition_version
  JOIN json_each(version.version_json, '$.steps') AS step
    ON json_extract(step.value, '$.id') = sr.step_id
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.attempt = new.attempt
    AND json_extract(step.value, '$.effectType') = 'WORKSPACE_MUTATION'
    AND json_extract(step.value, '$.effectPathMode') = 'DYNAMIC'
    AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
    AND json_extract(version.version_json, '$.validationPolicy') = 'software-integrity-v1'
)) BEGIN
  SELECT RAISE(ABORT, 'W2 PREPARED operation manifest must capture only the exact declared before state');
END;
CREATE TRIGGER workflow_step_operation_receipts_manifest_validate_update
BEFORE UPDATE ON workflow_step_operation_receipts
WHEN ((new.effect_type IN ('NONE', 'EXTERNAL_ACTION')
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
        OR ((new.state IN ('APPLIED', 'VERIFIED') OR (new.state = 'UNKNOWN' AND json_array_length(new.manifest_json) > 0)) AND (
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
  ))) AND NOT (new.effect_type = 'WORKSPACE_MUTATION'
  AND EXISTS (
  SELECT 1 FROM workflow_step_runs AS sr
  JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
  JOIN workflow_versions AS version ON version.definition_id = run.definition_id
    AND version.version = run.definition_version
  JOIN json_each(version.version_json, '$.steps') AS step
    ON json_extract(step.value, '$.id') = sr.step_id
  WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
    AND sr.attempt = new.attempt
    AND json_extract(step.value, '$.effectType') = 'WORKSPACE_MUTATION'
    AND json_extract(step.value, '$.effectPathMode') = 'DYNAMIC'
    AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
    AND json_extract(version.version_json, '$.validationPolicy') = 'software-integrity-v1'
)
  AND (
    (new.state = 'PREPARED' AND json_array_length(new.manifest_json) = 0) OR (new.state = 'UNKNOWN' AND json_array_length(new.manifest_json) = 0)
    OR ((new.state IN ('APPLIED', 'VERIFIED') OR (new.state = 'UNKNOWN' AND json_array_length(new.manifest_json) > 0))
      AND EXISTS (
        SELECT 1 FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.operation_receipt_id = new.id
          AND journal.state = 'APPLIED'
      )
      AND json_array_length(new.manifest_json) = (
        SELECT COUNT(DISTINCT journal.relative_path)
        FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.operation_receipt_id = new.id
          AND journal.state = 'APPLIED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.operation_receipt_id = new.id
          AND journal.state != 'APPLIED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.manifest_json) AS entry
        WHERE json_type(entry.value) != 'object'
          OR json_type(entry.value, '$.relativePath') != 'text'
          OR (json_type(entry.value, '$.beforeHash') IS NOT NULL
            AND (json_type(entry.value, '$.beforeHash') != 'text'
              OR length(json_extract(entry.value, '$.beforeHash')) != 64
              OR lower(json_extract(entry.value, '$.beforeHash')) GLOB '*[^0-9a-f]*'))
          OR json_type(entry.value, '$.afterHash') != 'text'
          OR length(json_extract(entry.value, '$.afterHash')) != 64
          OR lower(json_extract(entry.value, '$.afterHash')) GLOB '*[^0-9a-f]*'
          OR EXISTS (SELECT 1 FROM json_each(entry.value) AS field
            WHERE field.key NOT IN ('relativePath', 'beforeHash', 'afterHash'))
          OR NOT EXISTS (
            SELECT 1 FROM workflow_workspace_mutation_journal AS latest
            WHERE latest.operation_receipt_id = new.id
              AND latest.relative_path = json_extract(entry.value, '$.relativePath')
              AND latest.state = 'APPLIED'
              AND latest.observed_after_hash = json_extract(entry.value, '$.afterHash')
              AND json_extract(entry.value, '$.beforeHash') IS (
                SELECT first.before_hash
                FROM workflow_workspace_mutation_journal AS first
                WHERE first.operation_receipt_id = new.id
                  AND first.relative_path = latest.relative_path
                ORDER BY first.created_at, first.id LIMIT 1
              )
              AND latest.created_at = (
                SELECT MAX(candidate.created_at)
                FROM workflow_workspace_mutation_journal AS candidate
                WHERE candidate.operation_receipt_id = new.id
                  AND candidate.relative_path = latest.relative_path
              )
          )
      )
    )
  )) BEGIN
  SELECT RAISE(ABORT, 'W2 operation manifest must match its declared paths and persisted state evidence');
END;
-- Revisions and Human Bridge typed artifacts use the existing trusted policy dispatch.
DROP TRIGGER workflow_artifacts_validate_insert;
CREATE TRIGGER workflow_artifacts_validate_insert BEFORE INSERT ON workflow_artifacts
WHEN (json_type(new.metadata_json,'$.acceptedSourceReport') IS NOT NULL AND new.source != 'HUMAN_BRIDGE') OR NOT EXISTS (
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
                    AND ((json_extract(event.payload_json,'$.capability') = 'FILE_WRITE'
                      AND json_extract(event.payload_json,'$.resource') = 'file:' || json_extract(new.metadata_json,'$.workspaceTag') || ':' || lower(replace(json_extract(item.value,'$.relativePath'),char(92),'/')))
                    OR (json_extract(event.payload_json,'$.source') = 'MCP'
                      AND json_extract(event.payload_json,'$.capability') = 'MCP_TOOL_EXECUTE'
                      AND EXISTS (SELECT 1 FROM json_each(event.payload_json,'$.artifactFiles') AS file
                        WHERE json_extract(file.value,'$.path') = json_extract(item.value,'$.relativePath')
                          AND json_extract(file.value,'$.contentHash') = json_extract(item.value,'$.afterHash'))))
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
      AND (json_extract(ext.metadata_json,'$.contentHash') IS NULL OR json_extract(new.metadata_json,'$.contentHash') = json_extract(ext.metadata_json,'$.contentHash'))
      AND new.content = ''
  ))
  OR (new.source = 'HUMAN_BRIDGE' AND new.kind IN ('JSON','TEXT') AND EXISTS (
    SELECT 1 FROM external_work_artifacts AS ext
    JOIN external_work_requests AS req ON req.id = ext.external_work_request_id
    JOIN mission_runs AS mr ON mr.id = req.run_id AND mr.mission_id = req.mission_id
    JOIN missions AS m ON m.id = mr.mission_id
    JOIN workflow_step_runs AS sr ON sr.id = new.producer_step_run_id
    JOIN workflow_runs AS wr ON wr.id = sr.workflow_run_id
    JOIN workflow_versions AS v ON v.definition_id = wr.definition_id AND v.version = wr.definition_version
    JOIN json_each(v.version_json,'$.steps') AS step ON json_extract(step.value,'$.id') = sr.step_id
    JOIN json_each(step.value,'$.outputs') AS spec
    WHERE ext.id = new.source_id AND req.state = 'ACCEPTED' AND ext.submitted_at = req.submitted_at
      AND req.mission_id = new.mission_id AND req.run_id = new.mission_run_id
      AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED' AND req.assignee_teammate_id = new.actor_id
      AND json_extract(v.version_json,'$.definition.source') = 'BUILTIN'
      AND json_extract(v.version_json,'$.validationPolicy') IN ('news-integrity-v1','software-integrity-v1')
      AND json_extract(spec.value,'$.key') = json_extract(ext.metadata_json,'$.targetArtifactId')
      AND json_extract(spec.value,'$.key') = json_extract(new.metadata_json,'$.outputKey')
      AND json_extract(spec.value,'$.kind') = new.kind
      AND json_extract(new.metadata_json,'$.path') = ext.path
      AND json_extract(new.metadata_json,'$.fileName') = ext.file_name
      AND json_extract(new.metadata_json,'$.extension') = ext.extension
      AND json_extract(new.metadata_json,'$.sizeBytes') = ext.size_bytes
      AND json_extract(new.metadata_json,'$.targetArtifactId') = json_extract(ext.metadata_json,'$.targetArtifactId')
      AND length(json_extract(new.metadata_json,'$.contentHash')) = 64
      AND lower(json_extract(new.metadata_json,'$.contentHash')) NOT GLOB '*[^0-9a-f]*'
      AND length(CAST(new.content AS BLOB)) <= json_extract(spec.value,'$.maxSizeBytes')
      AND json_extract(ext.metadata_json,'$.contentHash') = json_extract(new.metadata_json,'$.contentHash')
      AND (new.kind = 'TEXT' OR json_valid(new.content))
      AND (json_type(new.metadata_json,'$.acceptedSourceReport') IS NULL OR (
        new.kind = 'JSON' AND json_extract(new.metadata_json,'$.acceptedSourceReport') = 1
        AND json_extract(step.value,'$.executionRequirements.toolPurpose') = 'RESEARCH'
        AND json_extract(new.metadata_json,'$.sourceReportId') = ext.id
        AND json_extract(new.metadata_json,'$.sourceReportHash') = json_extract(new.metadata_json,'$.contentHash')
      ))
  ))
  OR (new.source = 'MISSION' AND new.kind = 'FILE' AND new.content = '' AND EXISTS (
    SELECT 1 FROM workflow_step_operation_receipts AS operation
    JOIN workflow_step_runs AS sr ON sr.id = operation.step_run_id
    JOIN mission_runs AS mr ON mr.id = sr.mission_run_id AND mr.mission_id = sr.mission_id
    JOIN missions AS m ON m.id = mr.mission_id
    JOIN json_each(operation.manifest_json) AS item
    JOIN mission_events AS event ON event.id = new.source_id
    JOIN json_each(event.payload_json,'$.artifactFiles') AS file
    WHERE operation.workflow_run_id = new.workflow_run_id AND sr.id = new.producer_step_run_id
      AND operation.attempt = sr.attempt AND operation.state IN ('APPLIED','VERIFIED')
      AND mr.id = new.mission_run_id AND m.id = new.mission_id AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED'
      AND event.mission_id = m.id AND event.run_id = mr.id AND event.actor_id = new.actor_id
      AND event.event_type = 'tool.result' AND json_extract(event.payload_json,'$.success') = 1
      AND json_extract(event.payload_json,'$.source') = 'MCP'
      AND json_extract(event.payload_json,'$.capability') = 'MCP_TOOL_EXECUTE'
      AND json_extract(new.metadata_json,'$.evidenceEventId') = event.id
      AND json_extract(file.value,'$.path') = json_extract(item.value,'$.relativePath')
      AND json_extract(file.value,'$.path') = json_extract(new.metadata_json,'$.path')
      AND json_extract(file.value,'$.contentHash') = json_extract(item.value,'$.afterHash')
      AND json_extract(file.value,'$.contentHash') = json_extract(new.metadata_json,'$.contentHash')
  )) OR (new.source = 'MISSION' AND new.kind = 'DIRECTORY' AND EXISTS (
    SELECT 1 FROM mission_runs AS mr
    JOIN missions AS m ON m.id = mr.mission_id
    JOIN workflow_step_runs AS sr ON sr.id = new.producer_step_run_id
      AND sr.workflow_run_id = new.workflow_run_id
    JOIN workflow_runs AS wr ON wr.id = sr.workflow_run_id
    JOIN workflow_versions AS v ON v.definition_id = wr.definition_id
      AND v.version = wr.definition_version
    JOIN workflow_steps AS ws ON ws.definition_id = wr.definition_id
      AND ws.version = wr.definition_version AND ws.id = sr.step_id
    JOIN json_each(ws.outputs_json) AS spec
      ON json_extract(spec.value, '$.key') = json_extract(new.metadata_json, '$.outputKey')
    JOIN workflow_artifact_contract_registry AS contract
      ON contract.contract_id = json_extract(spec.value, '$.contractId')
      AND contract.contract_version = json_extract(spec.value, '$.contractVersion')
    WHERE mr.id = new.mission_run_id AND mr.mission_id = new.mission_id
      AND mr.status = 'COMPLETED' AND m.state = 'COMPLETED'
      AND m.coordinator_teammate_id = new.actor_id AND new.source_id = mr.id
      AND json_extract(v.version_json, '$.definition.source') = 'BUILTIN'
      AND json_extract(v.version_json, '$.validationPolicy') = 'software-integrity-v1'
      AND ws.effect_type = 'NONE'
      AND json_extract(spec.value, '$.key') = 'software.changes'
      AND json_extract(spec.value, '$.kind') = 'DIRECTORY'
      AND json_extract(spec.value, '$.contractId') = json_extract(contract.contract_json, '$.contractId')
      AND json_extract(spec.value, '$.contractVersion') = json_extract(contract.contract_json, '$.contractVersion')
      AND json_extract(contract.contract_json, '$.validator.type') = 'WORKSPACE_MANIFEST'
      AND json_extract(contract.contract_json, '$.validator.dynamicPaths') = 1
      AND json_extract(new.metadata_json, '$.inspectedManifest') = 1
      AND json_valid(json_extract(new.metadata_json, '$.executionEvidence'))
      AND json_type(new.content, '$.entries') = 'array'
      AND (
        SELECT COUNT(*) FROM json_each(new.content, '$.entries')
      ) = (
        SELECT COUNT(DISTINCT journal.relative_path)
        FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.workflow_run_id = wr.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.workflow_run_id = wr.id AND journal.state != 'APPLIED'
      )
      AND json_array_length(json_extract(new.metadata_json, '$.executionEvidence')) = (
        SELECT COUNT(*) FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.workflow_run_id = wr.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.content, '$.entries') AS output
        WHERE json_type(output.value, '$.relativePath') != 'text'
          OR json_type(output.value, '$.afterHash') != 'text'
          OR (json_type(output.value, '$.beforeHash') IS NOT NULL
            AND (json_type(output.value, '$.beforeHash') != 'text'
              OR length(json_extract(output.value, '$.beforeHash')) != 64
              OR lower(json_extract(output.value, '$.beforeHash')) GLOB '*[^0-9a-f]*'))
          OR length(json_extract(output.value, '$.afterHash')) != 64
          OR lower(json_extract(output.value, '$.afterHash')) GLOB '*[^0-9a-f]*'
          OR EXISTS (SELECT 1 FROM json_each(output.value) AS field
            WHERE field.key NOT IN ('relativePath', 'beforeHash', 'afterHash'))
          OR NOT EXISTS (
            SELECT 1 FROM workflow_workspace_mutation_journal AS latest
            WHERE latest.workflow_run_id = wr.id
              AND latest.relative_path = json_extract(output.value, '$.relativePath')
              AND latest.workspace_tag = json_extract(new.metadata_json, '$.workspaceTag')
              AND latest.state = 'APPLIED'
              AND latest.observed_after_hash = json_extract(output.value, '$.afterHash')
              AND json_extract(output.value, '$.beforeHash') IS (
                SELECT first.before_hash
                FROM workflow_workspace_mutation_journal AS candidate
                JOIN workflow_workspace_mutation_journal AS first
                  ON first.workflow_run_id = candidate.workflow_run_id
                  AND first.relative_path = candidate.relative_path
                WHERE candidate.id = latest.id
                ORDER BY first.created_at, first.id LIMIT 1
              )
              AND latest.id = (
                SELECT candidate.id
                FROM workflow_workspace_mutation_journal AS candidate
                WHERE candidate.workflow_run_id = wr.id
                  AND candidate.relative_path = latest.relative_path
                ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
              )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_workspace_mutation_journal AS journal
        JOIN workflow_step_operation_receipts AS operation
          ON operation.id = journal.operation_receipt_id AND operation.state = 'VERIFIED'
        WHERE journal.workflow_run_id = wr.id
          AND journal.workspace_tag = json_extract(new.metadata_json, '$.workspaceTag')
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(json_extract(new.metadata_json, '$.executionEvidence')) AS evidence
            JOIN mission_events AS event
              ON event.id = json_extract(evidence.value, '$.sourceId')
            WHERE json_extract(evidence.value, '$.relativePath') = journal.relative_path
              AND json_extract(evidence.value, '$.actorId') = journal.teammate_id
              AND json_extract(evidence.value, '$.toolCallId') = journal.tool_call_id
              AND json_extract(evidence.value, '$.permissionResource') = journal.permission_resource
              AND json_extract(evidence.value, '$.workspaceTag') = journal.workspace_tag
              AND event.mission_id = journal.mission_id
              AND event.run_id = journal.mission_run_id
              AND event.actor_id = journal.teammate_id
              AND event.event_type = 'tool.result'
              AND json_extract(event.payload_json, '$.success') = 1
              AND json_extract(event.payload_json, '$.toolCallId') = journal.tool_call_id
              AND json_extract(event.payload_json, '$.capability') = 'FILE_WRITE'
              AND json_extract(event.payload_json, '$.resource') = journal.permission_resource
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(new.metadata_json, '$.executionEvidence')) AS evidence
        WHERE NOT EXISTS (
          SELECT 1 FROM workflow_workspace_mutation_journal AS journal
          JOIN mission_events AS event
            ON event.id = json_extract(evidence.value, '$.sourceId')
          WHERE journal.workflow_run_id = wr.id
            AND journal.relative_path = json_extract(evidence.value, '$.relativePath')
            AND journal.teammate_id = json_extract(evidence.value, '$.actorId')
            AND journal.tool_call_id = json_extract(evidence.value, '$.toolCallId')
            AND event.mission_id = journal.mission_id AND event.run_id = journal.mission_run_id
            AND event.actor_id = journal.teammate_id AND event.event_type = 'tool.result'
            AND json_extract(event.payload_json, '$.success') = 1
            AND json_extract(event.payload_json, '$.toolCallId') = journal.tool_call_id
            AND json_extract(event.payload_json, '$.resource') = journal.permission_resource
        )
      )
  ))) OR EXISTS (
  SELECT 1 FROM json_each(new.metadata_json) AS field
  WHERE replace(replace(lower(field.key), '_', ''), '-', '') LIKE '%privatememory%'
) BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact source, Run binding, actor, or metadata provenance is invalid');
END;
DROP TRIGGER workflow_step_runs_completion_guard;
CREATE TRIGGER workflow_step_runs_completion_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND NOT EXISTS (
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
