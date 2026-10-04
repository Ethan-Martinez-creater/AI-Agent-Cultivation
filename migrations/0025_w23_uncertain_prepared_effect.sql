-- Preserve uncertain PREPARED filesystem effects without inventing after hashes.
-- The existing transition trigger still requires unchanged manifest/output/reference
-- for UNKNOWN; APPLIED/VERIFIED and dynamic software journal validation remain strict.
DROP TRIGGER workflow_step_operation_receipts_manifest_validate_update;
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
        OR ((new.state IN ('APPLIED', 'VERIFIED') OR (new.state = 'UNKNOWN' AND old.state = 'APPLIED' AND json_array_length(new.manifest_json) > 0)) AND (
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
