-- Transactional identity-table rebuild: migration runner disables FK checks, then validates all FKs.
ALTER TABLE providers ADD COLUMN adapter_id TEXT;
DROP TRIGGER teammate_model_bindings_validate_insert;
DROP TRIGGER teammate_model_bindings_identity_immutable;
DROP TRIGGER teammate_model_bindings_credential_sync;
DROP TRIGGER teammate_model_bindings_no_delete;
DROP TRIGGER teammates_model_binding_identity_immutable;
DROP TRIGGER teammates_no_model_binding_for_user_bridge_insert;
DROP TRIGGER teammates_no_model_binding_for_user_bridge_update;
DROP TRIGGER runtime_profiles_bound_identity_immutable;
DROP TRIGGER runtime_profiles_bound_credential_guard;
DROP TRIGGER providers_bound_identity_immutable;
DROP TRIGGER provider_credentials_bound_provider_immutable;
DROP TRIGGER teammate_model_availability_validate_insert;
DROP TRIGGER teammate_model_bindings_availability_insert;
DROP TRIGGER teammate_model_bindings_availability_credential_reset;
DROP TRIGGER provider_credentials_availability_key_reset;
DROP TRIGGER teammate_model_availability_validate_update;
DROP TRIGGER teammate_model_bindings_execution_protocol_immutable;
DROP TRIGGER teammate_model_bindings_protocol_matches_runtime;
DROP TRIGGER generation_jobs_validate_insert;
CREATE TABLE g2_model_bindings (
  teammate_id TEXT PRIMARY KEY REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL UNIQUE REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN (
    'OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENAI_COMPATIBLE', 'GENERATION_HTTP'
  )),
  adapter_id TEXT,
  execution_protocol TEXT NOT NULL DEFAULT 'LANGUAGE' CHECK (execution_protocol IN ('LANGUAGE','GENERATION')),
  endpoint TEXT,
  model_id TEXT NOT NULL,
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE RESTRICT,
  verified_at TEXT CHECK (verified_at IS NULL OR length(trim(verified_at)) BETWEEN 1 AND 64),
  verification_source TEXT NOT NULL CHECK (verification_source IN ('LIVE_TEST', 'LEGACY_STRUCTURAL')),
  sealed_at TEXT NOT NULL CHECK (length(trim(sealed_at)) BETWEEN 1 AND 64),
  CHECK ((verification_source = 'LIVE_TEST' AND verified_at IS NOT NULL)
    OR (verification_source = 'LEGACY_STRUCTURAL' AND verified_at IS NULL))
);
INSERT INTO g2_model_bindings (teammate_id,runtime_profile_id,provider_kind,endpoint,model_id,credential_id,verified_at,verification_source,sealed_at,execution_protocol) SELECT teammate_id,runtime_profile_id,provider_kind,endpoint,model_id,credential_id,verified_at,verification_source,sealed_at,execution_protocol FROM teammate_model_bindings;
DROP TABLE teammate_model_bindings;
ALTER TABLE g2_model_bindings RENAME TO teammate_model_bindings;
CREATE INDEX teammate_model_bindings_provider_model_idx ON teammate_model_bindings(provider_kind,model_id,teammate_id);
CREATE TRIGGER g2_provider_adapter_structure_insert BEFORE INSERT ON providers
WHEN (new.kind = 'GENERATION_HTTP' AND (new.adapter_id IS NULL
 OR length(new.adapter_id) NOT BETWEEN 1 AND 80 OR new.adapter_id GLOB '*[^A-Z0-9_-]*'
 OR substr(new.adapter_id,1,1) NOT GLOB '[A-Z]' OR new.base_url IS NULL))
 OR (new.kind != 'GENERATION_HTTP' AND new.adapter_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Unsupported generation adapter identity'); END;
CREATE TRIGGER g2_provider_adapter_identity_update BEFORE UPDATE OF adapter_id,kind ON providers
WHEN (new.adapter_id IS NOT old.adapter_id AND EXISTS (
 SELECT 1 FROM runtime_profiles rp JOIN teammate_model_bindings b ON b.runtime_profile_id=rp.id WHERE rp.provider_id=old.id))
 OR (new.kind = 'GENERATION_HTTP' AND (new.adapter_id IS NULL
 OR length(new.adapter_id) NOT BETWEEN 1 AND 80 OR new.adapter_id GLOB '*[^A-Z0-9_-]*'
 OR substr(new.adapter_id,1,1) NOT GLOB '[A-Z]' OR new.base_url IS NULL))
 OR (new.kind != 'GENERATION_HTTP' AND new.adapter_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Provider adapter identity is invalid or sealed'); END;
CREATE TRIGGER g2_binding_adapter_insert BEFORE INSERT ON teammate_model_bindings
WHEN NOT EXISTS (SELECT 1 FROM runtime_profiles rp JOIN providers p ON p.id=rp.provider_id
 WHERE rp.id=new.runtime_profile_id AND p.adapter_id IS new.adapter_id
 AND (p.kind!='GENERATION_HTTP' OR new.execution_protocol='GENERATION'))
BEGIN SELECT RAISE(ABORT, 'Generation adapter must match sealed identity'); END;
CREATE TRIGGER g2_binding_adapter_immutable BEFORE UPDATE OF adapter_id ON teammate_model_bindings
WHEN new.adapter_id IS NOT old.adapter_id BEGIN SELECT RAISE(ABORT, 'Sealed adapter is immutable'); END;
CREATE TRIGGER g2_runtime_provider_protocol_insert BEFORE INSERT ON runtime_profiles
WHEN new.execution_protocol!='GENERATION' AND EXISTS(SELECT 1 FROM providers WHERE id=new.provider_id AND kind='GENERATION_HTTP')
BEGIN SELECT RAISE(ABORT, 'Generation HTTP requires generation protocol'); END;
CREATE TRIGGER g2_runtime_provider_protocol_update BEFORE UPDATE OF provider_id ON runtime_profiles
WHEN new.execution_protocol!='GENERATION' AND EXISTS(SELECT 1 FROM providers WHERE id=new.provider_id AND kind='GENERATION_HTTP')
BEGIN SELECT RAISE(ABORT, 'Generation HTTP requires generation protocol'); END;

CREATE TABLE generation_adapter_submissions (
 runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 PRIMARY KEY(runtime_profile_id,idempotency_key),
 CHECK(json_extract(state_json,'$.runtimeId')=runtime_profile_id),
 CHECK(json_extract(state_json,'$.key')=idempotency_key),
 CHECK(json_extract(state_json,'$.phase') IN ('PREPARED','SUBMITTING','SUBMITTED','UNKNOWN'))
);
CREATE TRIGGER generation_adapter_submission_identity BEFORE UPDATE ON generation_adapter_submissions
WHEN new.runtime_profile_id IS NOT old.runtime_profile_id OR new.idempotency_key IS NOT old.idempotency_key
 OR json_extract(new.state_json,'$.requestFingerprint') IS NOT json_extract(old.state_json,'$.requestFingerprint')
 OR json_extract(new.state_json,'$.semanticFingerprint') IS NOT json_extract(old.state_json,'$.semanticFingerprint')
 OR (json_extract(old.state_json,'$.phase') IN ('UNKNOWN','SUBMITTED') AND new.state_json IS NOT old.state_json)
 OR (json_extract(old.state_json,'$.phase')='SUBMITTING' AND json_extract(new.state_json,'$.phase') NOT IN ('SUBMITTING','SUBMITTED','UNKNOWN'))
BEGIN SELECT RAISE(ABORT, 'Generation submission identity or terminal fact is immutable'); END;
CREATE TRIGGER generation_adapter_submission_retained BEFORE DELETE ON generation_adapter_submissions
BEGIN SELECT RAISE(ABORT, 'Generation submission history is retained'); END;

CREATE TABLE generation_input_artifacts (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('IMAGE','AUDIO','VIDEO')),
 mime_type TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 storage_key TEXT NOT NULL UNIQUE, metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 created_at TEXT NOT NULL
);
CREATE TRIGGER generation_input_artifacts_immutable BEFORE UPDATE ON generation_input_artifacts
BEGIN SELECT RAISE(ABORT, 'Imported media identity is immutable'); END;
CREATE TRIGGER generation_input_artifacts_retained BEFORE DELETE ON generation_input_artifacts
BEGIN SELECT RAISE(ABORT, 'Imported media provenance is retained'); END;

CREATE TABLE generation_chat_entries (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
 teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
 job_id TEXT UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
 inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json) AND json_array_length(inputs_json)<=16),
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json) AND length(parameters_json)<=8000),
 preparation_error_code TEXT, created_at TEXT NOT NULL
);
CREATE INDEX generation_chat_conversation ON generation_chat_entries(conversation_id,created_at,message_id);
CREATE TRIGGER generation_chat_entries_validate BEFORE INSERT ON generation_chat_entries
WHEN new.job_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id
 JOIN teammates t ON t.id=c.teammate_id JOIN teammate_model_bindings b ON b.teammate_id=t.id
 JOIN runtime_profiles rp ON rp.id=b.runtime_profile_id JOIN providers p ON p.id=rp.provider_id
 WHERE c.id=new.conversation_id AND c.teammate_id=new.teammate_id AND m.id=new.message_id
 AND m.role='USER' AND rp.execution_protocol='GENERATION' AND p.kind='GENERATION_HTTP')
BEGIN SELECT RAISE(ABORT, 'Generation chat requires its real user message and sealed execution owner'); END;
CREATE TRIGGER generation_chat_entries_guard BEFORE UPDATE ON generation_chat_entries
WHEN new.message_id IS NOT old.message_id OR new.conversation_id IS NOT old.conversation_id
 OR new.teammate_id IS NOT old.teammate_id OR new.inputs_json IS NOT old.inputs_json
 OR new.parameters_json IS NOT old.parameters_json OR new.created_at IS NOT old.created_at
 OR (old.job_id IS NOT NULL AND new.job_id IS NOT old.job_id)
 OR (new.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_jobs j JOIN generation_tasks gt ON gt.id=j.generation_task_id
 WHERE j.id=new.job_id AND j.teammate_id=new.teammate_id AND json_extract(gt.task_json,'$.requester.actorId')=new.message_id
 AND json_extract(gt.task_json,'$.requester.actorType')='USER'
 AND json_extract(gt.task_json,'$.outputDestination.scope')='APP_ARTIFACT_STORE'))
BEGIN SELECT RAISE(ABORT, 'Generation conversation provenance is immutable'); END;
CREATE TRIGGER generation_chat_job_bind AFTER INSERT ON generation_jobs
BEGIN UPDATE generation_chat_entries SET job_id=new.id WHERE message_id=(SELECT json_extract(task_json,'$.requester.actorId') FROM generation_tasks WHERE id=new.generation_task_id)
 AND teammate_id=new.teammate_id AND job_id IS NULL; END;
CREATE TRIGGER generation_chat_entries_retained BEFORE DELETE ON generation_chat_entries
BEGIN SELECT RAISE(ABORT, 'Generation chat history is retained'); END;
CREATE TRIGGER generation_chat_message_immutable BEFORE UPDATE ON messages
WHEN EXISTS(SELECT 1 FROM generation_chat_entries WHERE message_id=old.id)
 AND (new.id IS NOT old.id OR new.mission_id IS NOT old.mission_id OR new.conversation_id IS NOT old.conversation_id
 OR new.teammate_id IS NOT old.teammate_id OR new.actor_type IS NOT old.actor_type OR new.actor_id IS NOT old.actor_id
 OR new.role IS NOT old.role OR new.content IS NOT old.content OR new.created_at IS NOT old.created_at)
BEGIN SELECT RAISE(ABORT, 'Generation user message is an immutable submission fact'); END;
CREATE TRIGGER generation_chat_owner_immutable BEFORE UPDATE OF teammate_id ON conversations
WHEN new.teammate_id IS NOT old.teammate_id AND EXISTS(SELECT 1 FROM generation_chat_entries WHERE conversation_id=old.id)
BEGIN SELECT RAISE(ABORT, 'Generation conversation execution ownership is immutable'); END;
CREATE TRIGGER teammate_model_bindings_validate_insert
BEFORE INSERT ON teammate_model_bindings
WHEN (new.verification_source = 'LIVE_TEST' AND new.verified_at IS NULL)
  OR (new.verification_source = 'LEGACY_STRUCTURAL' AND new.verified_at IS NOT NULL)
  OR NOT EXISTS (
  SELECT 1
  FROM teammates AS t
  JOIN runtime_profiles AS rp ON rp.id = t.current_runtime_profile_id
  JOIN providers AS p ON p.id = rp.provider_id
  WHERE t.id = new.teammate_id
    AND t.executor_kind = 'MODEL_RUNTIME'
    AND t.current_runtime_profile_id = new.runtime_profile_id
    AND rp.model_id = new.model_id
    AND rp.credential_id IS new.credential_id
    AND p.kind = new.provider_kind
    AND p.base_url IS new.endpoint
    AND (new.credential_id IS NULL OR EXISTS (
      SELECT 1 FROM provider_credentials AS c
      WHERE c.id = new.credential_id AND c.provider_id = p.id
    ))
) BEGIN
  SELECT RAISE(ABORT, 'ModelBinding must snapshot the teammate current Runtime and Provider identity');
END;
CREATE TRIGGER teammate_model_bindings_identity_immutable
BEFORE UPDATE ON teammate_model_bindings
WHEN new.teammate_id IS NOT old.teammate_id
  OR new.runtime_profile_id IS NOT old.runtime_profile_id
  OR new.provider_kind IS NOT old.provider_kind
  OR new.endpoint IS NOT old.endpoint
  OR new.model_id IS NOT old.model_id
  OR new.verified_at IS NOT old.verified_at
  OR new.verification_source IS NOT old.verification_source
  OR new.sealed_at IS NOT old.sealed_at
  OR (new.credential_id IS NULL AND old.credential_id IS NOT NULL
    AND old.provider_kind != 'OPENAI_COMPATIBLE')
  OR (new.credential_id IS NOT old.credential_id AND new.credential_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runtime_profiles AS rp
      JOIN provider_credentials AS c ON c.id = new.credential_id
      WHERE rp.id = old.runtime_profile_id AND c.provider_id = rp.provider_id
    )) BEGIN
  SELECT RAISE(ABORT, 'Sealed ModelBinding identity is immutable; only a same-Provider credential can rotate');
END;
CREATE TRIGGER teammate_model_bindings_credential_sync
AFTER UPDATE OF credential_id ON teammate_model_bindings
WHEN new.credential_id IS NOT old.credential_id BEGIN
  UPDATE runtime_profiles SET credential_id = new.credential_id
  WHERE id = new.runtime_profile_id;
END;
CREATE TRIGGER teammate_model_bindings_no_delete
BEFORE DELETE ON teammate_model_bindings BEGIN
  SELECT RAISE(ABORT, 'Sealed ModelBinding is retained');
END;
CREATE TRIGGER teammates_model_binding_identity_immutable
BEFORE UPDATE OF executor_kind, system_kind, current_runtime_profile_id ON teammates
WHEN EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b WHERE b.teammate_id = old.id
) AND (new.executor_kind IS NOT old.executor_kind
  OR new.system_kind IS NOT old.system_kind
  OR new.current_runtime_profile_id IS NOT old.current_runtime_profile_id) BEGIN
  SELECT RAISE(ABORT, 'A sealed MODEL_RUNTIME teammate cannot change executor or Runtime identity');
END;
CREATE TRIGGER teammates_no_model_binding_for_user_bridge_insert
BEFORE INSERT ON teammates
WHEN new.executor_kind = 'USER_BRIDGE' AND EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b WHERE b.teammate_id = new.id
) BEGIN
  SELECT RAISE(ABORT, 'USER_BRIDGE teammates cannot have ModelBindings');
END;
CREATE TRIGGER teammates_no_model_binding_for_user_bridge_update
BEFORE UPDATE OF executor_kind ON teammates
WHEN new.executor_kind = 'USER_BRIDGE' AND EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b WHERE b.teammate_id = new.id
) BEGIN
  SELECT RAISE(ABORT, 'USER_BRIDGE teammates cannot have ModelBindings');
END;
CREATE TRIGGER runtime_profiles_bound_identity_immutable
BEFORE UPDATE OF provider_id, model_id ON runtime_profiles
WHEN EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b WHERE b.runtime_profile_id = old.id
) AND (new.provider_id IS NOT old.provider_id OR new.model_id IS NOT old.model_id) BEGIN
  SELECT RAISE(ABORT, 'A bound Runtime cannot change Provider or Model ID');
END;
CREATE TRIGGER runtime_profiles_bound_credential_guard
BEFORE UPDATE OF credential_id ON runtime_profiles
WHEN EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b
  WHERE b.runtime_profile_id = old.id AND b.credential_id IS NOT new.credential_id
) BEGIN
  SELECT RAISE(ABORT, 'A bound Runtime credential can change only through ModelBinding rotation');
END;
CREATE TRIGGER providers_bound_identity_immutable
BEFORE UPDATE OF kind, base_url ON providers
WHEN EXISTS (
  SELECT 1 FROM runtime_profiles AS rp
  JOIN teammate_model_bindings AS b ON b.runtime_profile_id = rp.id
  WHERE rp.provider_id = old.id
) AND (new.kind IS NOT old.kind OR new.base_url IS NOT old.base_url) BEGIN
  SELECT RAISE(ABORT, 'A Provider kind or endpoint used by a sealed ModelBinding is immutable');
END;
CREATE TRIGGER provider_credentials_bound_provider_immutable
BEFORE UPDATE OF provider_id ON provider_credentials
WHEN new.provider_id IS NOT old.provider_id AND EXISTS (
  SELECT 1 FROM teammate_model_bindings AS b WHERE b.credential_id = old.id
) BEGIN
  SELECT RAISE(ABORT, 'A credential used by a sealed ModelBinding cannot change Provider');
END;
CREATE TRIGGER teammate_model_availability_validate_insert
BEFORE INSERT ON teammate_model_availability
WHEN NOT EXISTS (
    SELECT 1 FROM teammate_model_bindings AS b
    JOIN teammates AS t ON t.id = b.teammate_id
    WHERE b.teammate_id = new.teammate_id
      AND b.runtime_profile_id = new.runtime_profile_id
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = b.runtime_profile_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(new.recent_outcomes_json) AS outcome
    WHERE outcome.type != 'object'
      OR json_type(outcome.value, '$.kind') IS NOT 'text'
      OR json_extract(outcome.value, '$.kind') NOT IN ('SUCCESS', 'HARD_FAILURE', 'TRANSIENT_FAILURE')
      OR json_type(outcome.value, '$.code') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.code'))) NOT BETWEEN 1 AND 80
      OR json_extract(outcome.value, '$.code') GLOB '*[^A-Za-z0-9_.:-]*'
      OR json_type(outcome.value, '$.checkedAt') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.checkedAt'))) NOT BETWEEN 1 AND 64
      OR EXISTS (
        SELECT 1 FROM json_each(outcome.value) AS field
        WHERE field.key NOT IN ('kind', 'code', 'checkedAt')
      )
  ) BEGIN
  SELECT RAISE(ABORT, 'Availability requires the exact sealed MODEL_RUNTIME binding');
END;
CREATE TRIGGER teammate_model_bindings_availability_insert
AFTER INSERT ON teammate_model_bindings BEGIN
  INSERT INTO teammate_model_availability (
    teammate_id, runtime_profile_id, status, last_checked_at, last_success_at,
    last_failure_at, recent_outcomes_json, policy_version, updated_at
  ) VALUES (
    new.teammate_id, new.runtime_profile_id, 'UNKNOWN', NULL, NULL, NULL, '[]',
    'r3-2-availability-v1', new.sealed_at
  );
END;
CREATE TRIGGER teammate_model_bindings_availability_credential_reset
AFTER UPDATE OF credential_id ON teammate_model_bindings
WHEN new.credential_id IS NOT old.credential_id BEGIN
  UPDATE teammate_model_availability
  SET status = 'UNKNOWN', last_checked_at = NULL, last_success_at = NULL,
      last_failure_at = NULL, recent_outcomes_json = '[]',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE teammate_id = new.teammate_id;
END;
CREATE TRIGGER provider_credentials_availability_key_reset
AFTER UPDATE OF ciphertext ON provider_credentials
WHEN new.ciphertext IS NOT old.ciphertext BEGIN
  UPDATE teammate_model_availability
  SET status = 'UNKNOWN', last_checked_at = NULL, last_success_at = NULL,
      last_failure_at = NULL, recent_outcomes_json = '[]',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE teammate_id IN (
    SELECT teammate_id FROM teammate_model_bindings WHERE credential_id = new.id
  );
END;
CREATE TRIGGER teammate_model_availability_validate_update
BEFORE UPDATE ON teammate_model_availability
WHEN new.teammate_id IS NOT old.teammate_id
  OR new.runtime_profile_id IS NOT old.runtime_profile_id
  OR NOT EXISTS (
    SELECT 1 FROM teammate_model_bindings AS b
    JOIN teammates AS t ON t.id = b.teammate_id
    WHERE b.teammate_id = new.teammate_id
      AND b.runtime_profile_id = new.runtime_profile_id
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = b.runtime_profile_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(new.recent_outcomes_json) AS outcome
    WHERE outcome.type != 'object'
      OR json_type(outcome.value, '$.kind') IS NOT 'text'
      OR json_extract(outcome.value, '$.kind') NOT IN ('SUCCESS', 'HARD_FAILURE', 'TRANSIENT_FAILURE')
      OR json_type(outcome.value, '$.code') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.code'))) NOT BETWEEN 1 AND 80
      OR json_extract(outcome.value, '$.code') GLOB '*[^A-Za-z0-9_.:-]*'
      OR json_type(outcome.value, '$.checkedAt') IS NOT 'text'
      OR length(trim(json_extract(outcome.value, '$.checkedAt'))) NOT BETWEEN 1 AND 64
      OR EXISTS (
        SELECT 1 FROM json_each(outcome.value) AS field
        WHERE field.key NOT IN ('kind', 'code', 'checkedAt')
      )
  ) BEGIN
  SELECT RAISE(ABORT, 'Availability projection has an invalid sealed identity or outcome');
END;
CREATE TRIGGER teammate_model_bindings_execution_protocol_immutable
BEFORE UPDATE OF execution_protocol ON teammate_model_bindings
WHEN new.execution_protocol IS NOT old.execution_protocol BEGIN
  SELECT RAISE(ABORT, 'Sealed ModelBinding execution protocol is immutable');
END;
CREATE TRIGGER teammate_model_bindings_protocol_matches_runtime
BEFORE INSERT ON teammate_model_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_profiles AS rp
  WHERE rp.id = new.runtime_profile_id
    AND rp.execution_protocol = new.execution_protocol
) BEGIN
  SELECT RAISE(ABORT, 'ModelBinding execution protocol must match its Runtime');
END;
CREATE TRIGGER generation_jobs_validate_insert
BEFORE INSERT ON generation_jobs
WHEN new.state != 'PENDING'
  OR new.provider_job_id IS NOT NULL
  OR new.provider_status IS NOT NULL
  OR new.error_code IS NOT NULL
  OR new.completed_at IS NOT NULL
  OR new.output_artifact_ids_json != '[]'
  OR new.idempotency_key != new.generation_task_id
  OR NOT EXISTS (
    SELECT 1
    FROM generation_tasks AS task
    JOIN teammates AS t ON t.id = new.teammate_id
    JOIN runtime_profiles AS rp ON rp.id = new.runtime_profile_id
    JOIN teammate_model_bindings AS binding
      ON binding.teammate_id = t.id AND binding.runtime_profile_id = rp.id
    WHERE task.id = new.generation_task_id
      AND task.target_teammate_id = new.teammate_id
      AND json_extract(task.task_json, '$.targetTeammateId') = new.teammate_id
      AND task.created_at = new.created_at
      AND t.executor_kind = 'MODEL_RUNTIME'
      AND t.system_kind IS NULL
      AND t.current_runtime_profile_id = new.runtime_profile_id
      AND rp.execution_protocol = 'GENERATION'
      AND binding.execution_protocol = 'GENERATION'
      AND json_extract(task.descriptor_json, '$.modelId') = rp.model_id
      AND json_extract(task.task_json, '$.capability') = json_extract(task.descriptor_json, '$.outputCapability')
  )
BEGIN
  SELECT RAISE(ABORT, 'GenerationJob requires the teammate current sealed GENERATION Runtime');
END;
