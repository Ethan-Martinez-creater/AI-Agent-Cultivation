-- R3.1 seals the execution identity of every existing MODEL_RUNTIME teammate.
-- A Runtime profile is mutable configuration, so copy it per teammate before
-- recording the immutable provider/endpoint/model snapshot. Historical Usage,
-- Mission, Event, Audit, benchmark, and evidence rows continue to reference the
-- original facts and Runtime IDs.

CREATE TEMP TABLE r3_1_migration_assert (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO r3_1_migration_assert (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM teammates AS t
  LEFT JOIN runtime_profiles AS rp ON rp.id = t.current_runtime_profile_id
  WHERE t.executor_kind = 'MODEL_RUNTIME'
    AND (t.current_runtime_profile_id IS NULL OR rp.id IS NULL)
) OR EXISTS (
  SELECT 1 FROM teammates AS t
  WHERE t.system_kind = 'HUMAN_BRIDGE'
    AND (t.status != 'ACTIVE' OR t.executor_kind != 'USER_BRIDGE'
      OR t.routing_policy != 'FALLBACK_ONLY' OR t.current_runtime_profile_id IS NOT NULL)
) THEN 0 ELSE 1 END;
DROP TABLE r3_1_migration_assert;

CREATE TEMP TABLE r3_1_runtime_clone_map (
  teammate_id TEXT PRIMARY KEY,
  source_runtime_profile_id TEXT NOT NULL,
  runtime_profile_id TEXT NOT NULL UNIQUE
);
INSERT INTO r3_1_runtime_clone_map (teammate_id, source_runtime_profile_id, runtime_profile_id)
SELECT id, current_runtime_profile_id, 'r31_' || lower(hex(randomblob(16)))
FROM teammates
WHERE executor_kind = 'MODEL_RUNTIME';

INSERT INTO runtime_profiles (
  id, name, provider_id, credential_id, model_id, parameters_json,
  capability_overrides_json, created_at, updated_at
)
SELECT
  m.runtime_profile_id, rp.name, rp.provider_id, rp.credential_id, rp.model_id,
  rp.parameters_json, rp.capability_overrides_json, rp.created_at, rp.updated_at
FROM r3_1_runtime_clone_map AS m
JOIN runtime_profiles AS rp ON rp.id = m.source_runtime_profile_id;

-- Keep the currently active execution pointer private to each teammate. Old
-- Runtime rows remain in place for historical Usage and Audit references.
UPDATE teammates
SET current_runtime_profile_id = (
  SELECT runtime_profile_id FROM r3_1_runtime_clone_map
  WHERE teammate_id = teammates.id
)
WHERE executor_kind = 'MODEL_RUNTIME';

-- A cloned Runtime must continue to expose its source model's benchmark facts.
-- The source records remain append-only history; these are equivalent snapshots
-- attached to the private Runtime identity.
INSERT INTO model_capability_benchmarks (
  id, runtime_profile_id, model_alias, dimension, supported, normalized_score,
  raw_score, source, benchmark, benchmark_version, snapshot_date, source_url,
  provenance_type, created_at
)
SELECT
  'r31_' || lower(hex(randomblob(16))), m.runtime_profile_id, b.model_alias,
  b.dimension, b.supported, b.normalized_score, b.raw_score, b.source, b.benchmark,
  b.benchmark_version, b.snapshot_date, b.source_url, b.provenance_type, b.created_at
FROM r3_1_runtime_clone_map AS m
JOIN model_capability_benchmarks AS b
  ON b.runtime_profile_id = m.source_runtime_profile_id;

CREATE TABLE teammate_model_bindings (
  teammate_id TEXT PRIMARY KEY REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL UNIQUE REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN (
    'OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENAI_COMPATIBLE'
  )),
  endpoint TEXT,
  model_id TEXT NOT NULL,
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE RESTRICT,
  verified_at TEXT CHECK (verified_at IS NULL OR length(trim(verified_at)) BETWEEN 1 AND 64),
  verification_source TEXT NOT NULL CHECK (verification_source IN ('LIVE_TEST', 'LEGACY_STRUCTURAL')),
  sealed_at TEXT NOT NULL CHECK (length(trim(sealed_at)) BETWEEN 1 AND 64),
  CHECK ((verification_source = 'LIVE_TEST' AND verified_at IS NOT NULL)
    OR (verification_source = 'LEGACY_STRUCTURAL' AND verified_at IS NULL))
);
CREATE INDEX teammate_model_bindings_provider_model_idx
  ON teammate_model_bindings(provider_kind, model_id, teammate_id);

-- Legacy Runtime rows never recorded a durable successful connection test.
-- Preserve the binding structure explicitly as legacy, without claiming it was
-- verified; the migration time records when the identity became sealed.
INSERT INTO teammate_model_bindings (
  teammate_id, runtime_profile_id, provider_kind, endpoint, model_id,
  credential_id, verified_at, verification_source, sealed_at
)
SELECT
  m.teammate_id, m.runtime_profile_id, p.kind, p.base_url, rp.model_id,
  rp.credential_id, NULL, 'LEGACY_STRUCTURAL',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM r3_1_runtime_clone_map AS m
JOIN runtime_profiles AS rp ON rp.id = m.runtime_profile_id
JOIN providers AS p ON p.id = rp.provider_id;

DROP TABLE r3_1_runtime_clone_map;

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

-- A binding credential rotation updates the private Runtime pointer in the same
-- transaction. Direct Runtime credential edits cannot diverge from the binding.
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

CREATE TRIGGER human_bridge_identity_insert_guard
BEFORE INSERT ON teammates
WHEN new.system_kind = 'HUMAN_BRIDGE'
  AND (new.status != 'ACTIVE' OR new.executor_kind != 'USER_BRIDGE'
    OR new.routing_policy != 'FALLBACK_ONLY' OR new.current_runtime_profile_id IS NOT NULL) BEGIN
  SELECT RAISE(ABORT, 'Human Bridge must remain ACTIVE, USER_BRIDGE, and FALLBACK_ONLY');
END;

CREATE TRIGGER human_bridge_identity_update_guard
BEFORE UPDATE OF status, executor_kind, routing_policy, system_kind, current_runtime_profile_id ON teammates
WHEN (new.system_kind = 'HUMAN_BRIDGE'
    AND (new.status != 'ACTIVE' OR new.executor_kind != 'USER_BRIDGE'
      OR new.routing_policy != 'FALLBACK_ONLY' OR new.current_runtime_profile_id IS NOT NULL))
  OR (old.system_kind = 'HUMAN_BRIDGE'
    AND (new.status IS NOT old.status OR new.executor_kind IS NOT old.executor_kind
      OR new.routing_policy IS NOT old.routing_policy OR new.system_kind IS NOT old.system_kind
      OR new.current_runtime_profile_id IS NOT old.current_runtime_profile_id)) BEGIN
  SELECT RAISE(ABORT, 'Human Bridge must remain ACTIVE, USER_BRIDGE, and FALLBACK_ONLY');
END;

CREATE TRIGGER human_bridge_no_delete_r3_1
BEFORE DELETE ON teammates
WHEN old.system_kind = 'HUMAN_BRIDGE' BEGIN
  SELECT RAISE(ABORT, 'Human Bridge teammate is retained');
END;

-- Durable ExternalWork continuation state. The request ID is the idempotency
-- key; all result payload can be rebuilt from the accepted request and artifacts.
CREATE TABLE r2_external_work_continuations (
  external_work_request_id TEXT PRIMARY KEY
    REFERENCES external_work_requests(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'CONSUMING', 'CONSUMED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK ((state = 'CONSUMED' AND consumed_at IS NOT NULL)
    OR (state != 'CONSUMED' AND consumed_at IS NULL))
);
CREATE INDEX r2_external_work_continuations_state_timeline_idx
  ON r2_external_work_continuations(state, created_at, external_work_request_id);
CREATE INDEX r2_external_work_continuations_run_state_idx
  ON r2_external_work_continuations(mission_run_id, state, external_work_request_id);

-- Recover old ACCEPTED requests while their exact Run is still active. The
-- previous implementation had no durable consumed marker; continuation code
-- detects an already saved FINAL artifact and consumes it without resynthesis.
INSERT INTO r2_external_work_continuations (
  external_work_request_id, mission_id, mission_run_id, state,
  created_at, updated_at, consumed_at
)
SELECT
  w.id, w.mission_id, w.run_id, 'PENDING',
  COALESCE(w.resolved_at, w.submitted_at, w.created_at),
  COALESCE(w.resolved_at, w.submitted_at, w.created_at), NULL
FROM external_work_requests AS w
JOIN missions AS m ON m.id = w.mission_id
JOIN mission_runs AS r ON r.id = w.run_id AND r.mission_id = w.mission_id
WHERE w.state = 'ACCEPTED'
  AND r.status = 'RUNNING'
  AND m.state IN ('WAITING_EXTERNAL_WORK', 'RUNNING');

CREATE TRIGGER r2_external_work_continuations_validate_insert
BEFORE INSERT ON r2_external_work_continuations
WHEN new.state != 'PENDING' OR new.consumed_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM external_work_requests AS w
  JOIN missions AS m ON m.id = w.mission_id
  JOIN mission_runs AS r ON r.id = w.run_id AND r.mission_id = w.mission_id
  WHERE w.id = new.external_work_request_id
    AND w.mission_id = new.mission_id AND w.run_id = new.mission_run_id
    AND w.state = 'ACCEPTED' AND m.state = 'WAITING_EXTERNAL_WORK'
) BEGIN
  SELECT RAISE(ABORT, 'Continuation requires an ACCEPTED request on its waiting Mission Run');
END;

CREATE TRIGGER r2_external_work_continuations_state_guard
BEFORE UPDATE ON r2_external_work_continuations
WHEN new.external_work_request_id IS NOT old.external_work_request_id
  OR new.mission_id IS NOT old.mission_id
  OR new.mission_run_id IS NOT old.mission_run_id
  OR new.created_at IS NOT old.created_at
  OR (old.state = 'PENDING' AND new.state NOT IN ('PENDING', 'CONSUMING'))
  OR (old.state = 'CONSUMING' AND new.state NOT IN ('CONSUMING', 'CONSUMED'))
  OR (old.state = 'CONSUMED' AND new.state != 'CONSUMED')
  OR (new.state = 'CONSUMED' AND new.consumed_at IS NULL)
  OR (new.state != 'CONSUMED' AND new.consumed_at IS NOT NULL)
  OR (old.state = 'CONSUMED' AND new.consumed_at IS NOT old.consumed_at) BEGIN
  SELECT RAISE(ABORT, 'Durable continuation identity and state transition are immutable');
END;

CREATE TRIGGER r2_external_work_continuations_no_delete
BEFORE DELETE ON r2_external_work_continuations BEGIN
  SELECT RAISE(ABORT, 'Durable continuations are retained');
END;
