-- Supplemental defense for dynamic software operation manifests. Preserve 0025's
-- uncertain PREPARED -> UNKNOWN semantics and all original transition guards.
CREATE TRIGGER workflow_dynamic_manifest_exact_journal
BEFORE UPDATE ON workflow_step_operation_receipts
WHEN new.effect_type = 'WORKSPACE_MUTATION'
  AND new.state IN ('APPLIED', 'VERIFIED', 'UNKNOWN')
  AND json_array_length(new.manifest_json) > 0
  AND EXISTS (
    SELECT 1 FROM workflow_step_runs AS sr
    JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
    JOIN workflow_versions AS version ON version.definition_id = run.definition_id
      AND version.version = run.definition_version
    JOIN json_each(version.version_json, '$.steps') AS step
      ON json_extract(step.value, '$.id') = sr.step_id
    WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
      AND json_extract(step.value, '$.effectPathMode') = 'DYNAMIC'
      AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
      AND json_extract(version.version_json, '$.validationPolicy') = 'software-integrity-v1'
  )
  AND (
    json_array_length(new.manifest_json) != (
      SELECT COUNT(DISTINCT json_extract(value, '$.relativePath'))
      FROM json_each(new.manifest_json)
    )
    OR EXISTS (
      SELECT 1 FROM workflow_workspace_mutation_journal AS journal
      WHERE journal.operation_receipt_id = new.id
        AND NOT EXISTS (
          SELECT 1 FROM json_each(new.manifest_json) AS entry
          WHERE json_extract(entry.value, '$.relativePath') = journal.relative_path
        )
    )
    OR EXISTS (
      SELECT 1 FROM json_each(new.manifest_json) AS entry
      WHERE json_extract(entry.value, '$.afterHash') IS NOT (
        SELECT journal.observed_after_hash
        FROM workflow_workspace_mutation_journal AS journal
        WHERE journal.operation_receipt_id = new.id
          AND journal.relative_path = json_extract(entry.value, '$.relativePath')
        ORDER BY journal.created_at DESC, journal.id DESC LIMIT 1
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Dynamic operation manifest must cover each journal path exactly once with its latest hash');
END;
