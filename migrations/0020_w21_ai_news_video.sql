-- W2.1 scoped delivery / accepted structured artifact provenance / explicit final confirmation.
-- All 0001–0019 durable facts remain unchanged.
DROP VIEW workflow_w2_operation_effect_paths;
CREATE VIEW workflow_w2_operation_effect_paths AS
WITH declared AS (
 SELECT sr.id AS step_run_id, sr.workflow_run_id, step.value AS step_json,
   json_extract(version.version_json,'$.validationPolicy') AS policy,
   CASE WHEN json_extract(step.value,'$.artifactPathScope') = 'RUN_ATTEMPT'
     THEN 'workflows/' || sr.workflow_run_id || '/' || sr.id || '/' ELSE '' END AS prefix,
   path.value AS relative_path
 FROM workflow_step_runs AS sr
 JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
 JOIN workflow_versions AS version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 JOIN json_each(version.version_json,'$.steps') AS step ON json_extract(step.value,'$.id') = sr.step_id
 JOIN json_each(step.value,'$.effectPaths') AS path
 WHERE json_type(version.version_json,'$.contractManifest') = 'array'
   AND json_type(step.value,'$.effectPaths') = 'array'
   AND json_extract(step.value,'$.effectType') IN ('FILE_OUTPUT','WORKSPACE_MUTATION') AND path.type = 'text'
)
SELECT DISTINCT workflow_run_id, step_run_id, json_extract(step_json,'$.effectType') AS effect_type, prefix || relative_path AS relative_path FROM declared
 WHERE NOT (COALESCE(policy = 'news-integrity-v1', 0) AND json_extract(step_json,'$.executionRequirements.toolPurpose') = 'ASSET_COLLECTION' AND relative_path = 'assets')
UNION ALL
SELECT declared.workflow_run_id, declared.step_run_id, json_extract(declared.step_json,'$.effectType'), declared.prefix || 'assets/' || json_extract(asset.value,'$.assetId') ||
 CASE WHEN json_extract(asset.value,'$.visualType') IN ('STOCK_BROLL','SCREEN_RECORDING') THEN '.mp4' ELSE '.png' END
FROM declared
JOIN workflow_artifact_bindings AS binding ON binding.step_run_id = declared.step_run_id AND binding.role = 'INPUT' AND binding.key = 'asset_manifest'
JOIN workflow_artifacts AS artifact ON artifact.id = binding.artifact_id
JOIN json_each(artifact.content,'$.assets') AS asset
WHERE declared.policy = 'news-integrity-v1'
 AND json_extract(declared.step_json,'$.executionRequirements.toolPurpose') = 'ASSET_COLLECTION' AND declared.relative_path = 'assets'
 AND json_array_length(artifact.content,'$.assets') BETWEEN 1 AND 20
 AND json_type(asset.value,'$.assetId') = 'text'
 AND length(json_extract(asset.value,'$.assetId')) BETWEEN 1 AND 80
 AND json_extract(asset.value,'$.assetId') NOT GLOB '*[^A-Za-z0-9_-]*'
 AND substr(json_extract(asset.value,'$.assetId'),1,1) GLOB '[A-Za-z0-9]';

CREATE TRIGGER workflow_user_confirmation_event_guard BEFORE INSERT ON workflow_events
WHEN new.type = 'workflow.user_confirmed' AND NOT EXISTS (
 SELECT 1 FROM workflow_step_runs AS sr JOIN workflow_runs AS run ON run.id = sr.workflow_run_id
 JOIN workflow_versions AS version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 JOIN json_each(version.version_json,'$.steps') AS step ON json_extract(step.value,'$.id') = sr.step_id
 WHERE sr.id = new.step_run_id AND run.id = new.workflow_run_id
 AND sr.state = 'WAITING' AND run.state = 'WAITING' AND sr.wait_reason = 'USER_CONFIRMATION'
 AND sr.error_code = 'FINAL_USER_CONFIRMATION_REQUIRED' AND json_extract(step.value,'$.confirmationRequired') = 1
 AND json_extract(new.payload_json,'$.stepRunId') = sr.id
 AND json_extract(new.payload_json,'$.actorKind') = 'USER'
 AND json_type(new.payload_json,'$.inputHash') = 'text' AND length(json_extract(new.payload_json,'$.inputHash')) = 64
 AND json_extract(new.payload_json,'$.inputHash') NOT GLOB '*[^0-9a-f]*'
) BEGIN SELECT RAISE(ABORT, 'User confirmation must match the waiting final delivery'); END;

CREATE TRIGGER workflow_step_runs_user_confirmation_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED'
  AND EXISTS (SELECT 1 FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.definition_id = run.definition_id AND version.version = run.definition_version
    JOIN json_each(version.version_json,'$.steps') AS step ON json_extract(step.value,'$.id') = new.step_id
    WHERE run.id = new.workflow_run_id AND json_extract(step.value,'$.confirmationRequired') = 1)
  AND NOT EXISTS (SELECT 1 FROM workflow_events AS event
    WHERE event.workflow_run_id = new.workflow_run_id AND event.step_run_id = new.id
      AND event.type = 'workflow.user_confirmed'
      AND json_extract(event.payload_json,'$.stepRunId') = new.id
      AND json_extract(event.payload_json,'$.actorKind') = 'USER'
      AND EXISTS (SELECT 1 FROM workflow_decisions AS decision WHERE decision.step_run_id = new.id
        AND decision.workflow_run_id = new.workflow_run_id AND decision.input_hash = json_extract(event.payload_json,'$.inputHash')))
BEGIN SELECT RAISE(ABORT, 'Final delivery requires explicit user confirmation'); END;

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
      AND json_extract(v.version_json,'$.validationPolicy') = 'news-integrity-v1'
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
  ))) OR EXISTS (
  SELECT 1 FROM json_each(new.metadata_json) AS field
  WHERE replace(replace(lower(field.key), '_', ''), '-', '') LIKE '%privatememory%'
) BEGIN
  SELECT RAISE(ABORT, 'Workflow Artifact source, Run binding, actor, or metadata provenance is invalid');
END;

-- News REVIEW completion permits only a committed, bounded declared revision.
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
           AND (COALESCE(json_extract(version.version_json,'$.validationPolicy') != 'news-integrity-v1',1) OR
             b.key = (SELECT COALESCE(json_extract(step.value,'$.reviewOutputKey'),
               (SELECT json_extract(candidate.value,'$.key') FROM json_each(step.value,'$.outputs') AS candidate
                 WHERE json_extract(candidate.value,'$.required') = 1 AND json_extract(candidate.value,'$.kind') = 'JSON' LIMIT 1))
               FROM json_each(version.version_json,'$.steps') AS step WHERE json_extract(step.value,'$.id') = new.step_id))
           AND v.contract_id = b.contract_id AND v.contract_version = b.contract_version
           AND v.content_hash = a.content_hash AND v.valid = 1
           AND json_valid(a.content) AND json_type(a.content) = 'object'
           AND (json_extract(a.content, '$.verdict') = 'PASS' OR (
             json_extract(version.version_json,'$.validationPolicy') = 'news-integrity-v1'
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
               AND NOT (field.key = 'revisionCode' AND json_extract(version.version_json,'$.validationPolicy') = 'news-integrity-v1')
           )
       ))
     ))
  )
BEGIN
  SELECT RAISE(ABORT, 'completed Workflow StepRun needs validated outputs and a terminal Mission Run, or a Decision fact and checkpoint');
END;

