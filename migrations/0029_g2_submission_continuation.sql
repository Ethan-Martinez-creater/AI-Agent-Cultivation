-- Preserve adapter facts while adding a terminal, explicitly unaccepted submission outcome.
DROP TRIGGER generation_adapter_submission_identity;
DROP TRIGGER generation_adapter_submission_retained;
CREATE TABLE g2_submission_outcomes (
 runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 PRIMARY KEY(runtime_profile_id,idempotency_key),
 CHECK(json_extract(state_json,'$.runtimeId')=runtime_profile_id),
 CHECK(json_extract(state_json,'$.key')=idempotency_key),
 CHECK(json_extract(state_json,'$.phase') IN ('PREPARED','SUBMITTING','SUBMITTED','UNKNOWN','REJECTED')),
 CHECK(json_extract(state_json,'$.phase')!='REJECTED' OR (
   json_type(state_json,'$.errorCode') IS 'text'
   AND json_extract(state_json,'$.errorCode') IN ('AUTH_FAILED','MODEL_NOT_FOUND','INVALID_INPUT',
     'UNSUPPORTED_FEATURE','UNSUPPORTED_INPUT_ROLE','MODEL_DURATION_LIMIT','QUEUE_FULL','IDEMPOTENCY_CONFLICT')
   AND json_extract(state_json,'$.providerJobId') IS NULL))
);
INSERT INTO g2_submission_outcomes SELECT * FROM generation_adapter_submissions;
DROP TABLE generation_adapter_submissions;
ALTER TABLE g2_submission_outcomes RENAME TO generation_adapter_submissions;
CREATE TRIGGER generation_adapter_submission_identity BEFORE UPDATE ON generation_adapter_submissions
WHEN new.runtime_profile_id IS NOT old.runtime_profile_id OR new.idempotency_key IS NOT old.idempotency_key
 OR json_extract(new.state_json,'$.requestFingerprint') IS NOT json_extract(old.state_json,'$.requestFingerprint')
 OR json_extract(new.state_json,'$.semanticFingerprint') IS NOT json_extract(old.state_json,'$.semanticFingerprint')
 OR (json_extract(old.state_json,'$.phase') IN ('UNKNOWN','SUBMITTED','REJECTED') AND new.state_json IS NOT old.state_json)
 OR (json_extract(old.state_json,'$.phase')='SUBMITTING' AND json_extract(new.state_json,'$.phase') NOT IN ('SUBMITTING','SUBMITTED','UNKNOWN','REJECTED'))
BEGIN SELECT RAISE(ABORT, 'Generation submission identity or terminal fact is immutable'); END;
CREATE TRIGGER generation_adapter_submission_retained BEFORE DELETE ON generation_adapter_submissions
BEGIN SELECT RAISE(ABORT, 'Generation submission history is retained'); END;

-- A committed message is the durable preparation intent. Its final preparation failure is immutable.
CREATE INDEX generation_chat_pending_preparation ON generation_chat_entries(created_at,message_id)
 WHERE job_id IS NULL AND preparation_error_code IS NULL;
CREATE TRIGGER generation_chat_preparation_terminal BEFORE UPDATE ON generation_chat_entries
WHEN (old.preparation_error_code IS NOT NULL AND new.preparation_error_code IS NOT old.preparation_error_code)
 OR (new.preparation_error_code IS NOT NULL AND new.job_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Generation preparation outcome is terminal'); END;
CREATE TRIGGER generation_chat_one_submission BEFORE INSERT ON generation_jobs
WHEN EXISTS (
 SELECT 1 FROM generation_tasks gt JOIN generation_chat_entries ce
 ON ce.message_id=json_extract(gt.task_json,'$.requester.actorId')
 WHERE gt.id=new.generation_task_id AND (
 ce.job_id IS NOT NULL OR ce.preparation_error_code IS NOT NULL
 OR ce.teammate_id IS NOT new.teammate_id
 OR json_extract(gt.task_json,'$.requester.actorType') IS NOT 'USER'
 OR json_extract(gt.task_json,'$.outputDestination.scope') IS NOT 'APP_ARTIFACT_STORE'))
BEGIN SELECT RAISE(ABORT, 'Generation chat intent already has an outcome or mismatched owner'); END;
