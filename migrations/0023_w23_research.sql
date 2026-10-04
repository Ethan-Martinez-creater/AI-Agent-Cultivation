-- W2.3: trusted frozen experiment mode and run-level bounded refinement.
-- Existing versions/artifacts/events are retained verbatim.
CREATE VIEW workflow_effective_step_types AS
SELECT sr.workflow_run_id, sr.id AS step_run_id, sr.attempt, sr.step_id,
 CASE WHEN run.definition_id = 'official.research' AND run.definition_version = 1
  AND json_extract(version.version_json, '$.definition.source') = 'BUILTIN'
  AND json_extract(version.version_json, '$.validationPolicy') = 'research-integrity-v1'
  AND sr.step_id = 'R08'
  AND json_extract(run.input_snapshot_json, '$.experimentMode') = 'HUMAN_OR_EXTERNAL'
 THEN 'EXTERNAL_ACTION' ELSE step.effect_type END AS effect_type
FROM workflow_step_runs sr JOIN workflow_runs run ON run.id = sr.workflow_run_id
JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
JOIN workflow_steps step ON step.definition_id = run.definition_id AND step.version = run.definition_version AND step.id = sr.step_id;

DROP TRIGGER workflow_step_operation_receipts_validate_insert;
CREATE TRIGGER workflow_step_operation_receipts_validate_insert BEFORE INSERT ON workflow_step_operation_receipts
WHEN new.state != 'PREPARED' OR json_array_length(new.output_artifact_ids_json) != 0
 OR new.external_reference IS NOT NULL OR NOT EXISTS (
 SELECT 1 FROM workflow_step_runs sr JOIN workflow_runs run ON run.id = sr.workflow_run_id
 JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 JOIN workflow_steps step ON step.definition_id = run.definition_id AND step.version = run.definition_version AND step.id = sr.step_id
 JOIN workflow_effective_step_types effective ON effective.step_run_id = sr.id
 WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
 AND sr.attempt = new.attempt AND step.type != 'DECISION'
 AND (sr.state = 'RUNNING' OR (
  sr.state = 'WAITING' AND sr.wait_reason = 'APPROVAL'
  AND sr.step_id = 'R08' AND new.effect_type = 'EXTERNAL_ACTION'
  AND json_extract(run.input_snapshot_json,'$.experimentMode') = 'MIXED'
  AND new.operation_key = 'workflow:' || run.id || ':' || sr.id || ':external'
  AND EXISTS (SELECT 1 FROM mission_runs mr WHERE mr.id = sr.mission_run_id
   AND mr.mission_id = sr.mission_id AND mr.status = 'RUNNING')
  AND EXISTS (SELECT 1 FROM mission_events event WHERE event.mission_id = sr.mission_id
   AND event.run_id = sr.mission_run_id AND event.event_type = 'tool.result'
   AND json_extract(event.payload_json,'$.success') = 1
   AND json_extract(event.payload_json,'$.source') = 'MCP'
   AND json_extract(event.payload_json,'$.capability') = 'MCP_TOOL_EXECUTE'
   AND json_type(event.payload_json,'$.researchExperiment') = 'object')
 ))
 AND (effective.effect_type = new.effect_type OR (run.definition_id = 'official.research' AND run.definition_version = 1
  AND json_extract(version.version_json,'$.definition.source') = 'BUILTIN'
  AND json_extract(version.version_json,'$.validationPolicy') = 'research-integrity-v1'
  AND sr.step_id = 'R08' AND new.effect_type = 'EXTERNAL_ACTION'
  AND json_extract(run.input_snapshot_json,'$.experimentMode') = 'MIXED'
  AND new.operation_key = 'workflow:' || run.id || ':' || sr.id || ':external'))
 AND json_type(version.version_json, '$.contractManifest') = 'array'
) BEGIN SELECT RAISE(ABORT, 'W2 operation must start PREPARED for its frozen effective StepRun'); END;

DROP TRIGGER workflow_step_runs_w2_completion_guard;
CREATE TRIGGER workflow_step_runs_w2_completion_guard BEFORE UPDATE OF state ON workflow_step_runs
WHEN new.state = 'COMPLETED' AND old.state != 'COMPLETED' AND EXISTS (
 SELECT 1 FROM workflow_runs run JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 JOIN workflow_steps step ON step.definition_id = run.definition_id AND step.version = run.definition_version AND step.id = new.step_id
 WHERE run.id = new.workflow_run_id AND json_type(version.version_json, '$.contractManifest') = 'array' AND step.type != 'DECISION'
) AND (NOT EXISTS (
 SELECT 1 FROM workflow_step_operation_receipts receipt JOIN workflow_effective_step_types effective ON effective.step_run_id = receipt.step_run_id
 WHERE receipt.workflow_run_id = new.workflow_run_id AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt
 AND receipt.effect_type = effective.effect_type AND receipt.state = 'VERIFIED'
) OR EXISTS (SELECT 1 FROM workflow_step_operation_receipts receipt WHERE receipt.workflow_run_id = new.workflow_run_id
 AND receipt.step_run_id = new.id AND receipt.attempt = new.attempt AND receipt.state != 'VERIFIED'))
BEGIN SELECT RAISE(ABORT, 'W2 StepRun completion requires verified operation receipts for effective execution'); END;

-- Additional guard tightens the already enforced static edge/group ceiling.
CREATE TRIGGER research_refinement_frozen_budget BEFORE INSERT ON workflow_revision_traversals
WHEN new.group_id = 'research.experiment_cycle' AND EXISTS (
 SELECT 1 FROM workflow_runs run JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 WHERE run.id = new.workflow_run_id AND run.definition_id = 'official.research' AND run.definition_version = 1
 AND json_extract(version.version_json, '$.validationPolicy') = 'research-integrity-v1'
 AND (COALESCE(json_extract(run.input_snapshot_json, '$.maxExperimentCycles'), 2) NOT BETWEEN 1 AND 2
 OR new.traversal_index > COALESCE(json_extract(run.input_snapshot_json, '$.maxExperimentCycles'), 2))
) BEGIN SELECT RAISE(ABORT, 'Research refinement exceeds frozen Run budget'); END;

CREATE TABLE research_source_artifacts (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
 id TEXT NOT NULL,
 step_run_id TEXT NOT NULL REFERENCES workflow_step_runs(id) ON DELETE RESTRICT,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
 mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
 event_id TEXT NOT NULL REFERENCES mission_events(id) ON DELETE RESTRICT,
 actor_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
 tool_call_id TEXT NOT NULL, tool_id TEXT NOT NULL,
 url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 1024),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
 output_hash TEXT NOT NULL CHECK(length(output_hash)=64 AND output_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(workflow_run_id,step_run_id,id),
 CHECK(id = 'source-' || content_hash)
);
CREATE INDEX research_source_artifacts_source_id ON research_source_artifacts(id,created_at,workflow_run_id);
CREATE TRIGGER research_source_artifacts_provenance BEFORE INSERT ON research_source_artifacts
WHEN NOT EXISTS (
 SELECT 1 FROM workflow_step_runs sr JOIN mission_events event ON event.id = new.event_id
 JOIN workflow_runs run ON run.id = sr.workflow_run_id
 JOIN workflow_versions version ON version.definition_id = run.definition_id AND version.version = run.definition_version
 WHERE sr.id = new.step_run_id AND sr.workflow_run_id = new.workflow_run_id
 AND sr.step_id = 'R02'
 AND sr.mission_id = new.mission_id AND sr.mission_run_id = new.mission_run_id
 AND run.definition_id = 'official.research' AND run.definition_version = 1
 AND json_extract(version.version_json,'$.definition.source') = 'BUILTIN'
 AND json_extract(version.version_json,'$.validationPolicy') = 'research-integrity-v1'
 AND event.mission_id = new.mission_id AND event.run_id = new.mission_run_id
 AND event.actor_id = new.actor_id AND event.actor_type = 'TEAMMATE' AND event.event_type = 'tool.result'
 AND json_extract(event.payload_json,'$.success') = 1 AND json_extract(event.payload_json,'$.source') = 'MCP'
 AND json_extract(event.payload_json,'$.capability') = 'MCP_TOOL_EXECUTE'
 AND json_extract(event.payload_json,'$.toolCallId') = new.tool_call_id
 AND json_extract(event.payload_json,'$.toolId') = new.tool_id
 AND json_extract(event.payload_json,'$.outputHash') = new.output_hash
 AND EXISTS (SELECT 1 FROM json_each(event.payload_json,'$.researchSources') source
 WHERE json_extract(source.value,'$.url') = new.url AND json_extract(source.value,'$.contentHash') = new.content_hash)
) BEGIN SELECT RAISE(ABORT,'Research source requires actual same-Step Tool provenance'); END;
CREATE TRIGGER research_source_artifacts_no_update BEFORE UPDATE ON research_source_artifacts
BEGIN SELECT RAISE(ABORT,'Research sources are immutable'); END;
CREATE TRIGGER research_source_artifacts_no_delete BEFORE DELETE ON research_source_artifacts
BEGIN SELECT RAISE(ABORT,'Research sources are retained'); END;

-- W2.3 accepted research artifacts: preserve the previous provenance guard verbatim,
-- adding only the trusted research policy to the accepted structured-delivery branch.
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
      AND json_extract(v.version_json,'$.validationPolicy') IN ('news-integrity-v1','software-integrity-v1','research-integrity-v1')
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

