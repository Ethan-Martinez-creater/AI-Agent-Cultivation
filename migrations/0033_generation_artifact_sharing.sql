-- User-approved sharing of completed app-store media into one Mission Run.
-- Preserve original workflow / same-Run / external-work provenance branches.
DROP TRIGGER g3_artifact_refs_validate_insert;

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
  ) AND NOT EXISTS (
    SELECT 1 FROM mission_events AS event
    JOIN generation_artifacts AS artifact ON artifact.id = new.artifact_id
    JOIN generation_jobs AS job ON job.id = artifact.job_id AND job.state = 'COMPLETED'
    JOIN generation_tasks AS task ON task.id = job.generation_task_id
    JOIN mission_runs AS run ON run.id = new.run_id AND run.mission_id = new.mission_id
    WHERE event.id = new.source_id
      AND event.mission_id = new.mission_id AND event.run_id = new.run_id
      AND event.event_type = 'collaboration.artifact_shared'
      AND event.actor_type = 'USER' AND event.actor_id = 'local-user'
      AND run.status = 'RUNNING'
      AND artifact.storage_scope = 'APP_ARTIFACT_STORE'
      AND json_extract(task.task_json, '$.outputDestination.scope') = 'APP_ARTIFACT_STORE'
      AND EXISTS (SELECT 1 FROM json_each(job.output_artifact_ids_json) WHERE value = artifact.id)
      AND json_extract(event.payload_json, '$.sourceJobId') = job.id
      AND json_extract(event.payload_json, '$.artifactId') = artifact.id
      AND json_extract(event.payload_json, '$.kind') = artifact.kind AND artifact.kind = new.kind
      AND json_extract(event.payload_json, '$.mimeType') = artifact.mime_type AND artifact.mime_type = new.mime_type
      AND json_extract(event.payload_json, '$.contentHash') = artifact.content_hash AND artifact.content_hash = new.content_hash
      AND json_extract(event.payload_json, '$.sizeBytes') = artifact.size_bytes AND artifact.size_bytes = new.size_bytes
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

